const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Events,
  MessageFlags,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle
} = require("discord.js");

const fs   = require("fs");
const path = require("path");

const TOKEN                  = process.env.BOT_TOKEN;
const CHANNEL_ID             = process.env.CHANNEL_ID;
const LOG_CHANNEL_ID         = process.env.LOG_CHANNEL_ID;
const DATA_BACKUP_CHANNEL_ID = process.env.DATA_BACKUP_CHANNEL_ID;

if (!TOKEN || !CHANNEL_ID) {
  console.error("ERROR: Missing BOT_TOKEN or CHANNEL_ID environment variables.");
  process.exit(1);
}
if (!LOG_CHANNEL_ID)         console.warn("[Warn] LOG_CHANNEL_ID not set.");
if (!DATA_BACKUP_CHANNEL_ID) console.warn("[Warn] DATA_BACKUP_CHANNEL_ID not set.");

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages]
});

// =====================
// SETTINGS
// =====================
const TICK_RATE = 5000;
const MAX_UNDO  = 10;

// =====================
// STATE
// =====================
let data = { kills: {} };
let dashboardMessage = null;

let spawnWarnings = {};

// spawnWindowMessages: { [bossId]: { msg, windowEnd, boss } }
let spawnWindowMessages = {};

// missedWindowDashboards: { [bossId]: { msg, nextWindowStart, nextWindowEnd, pingedStart, pinged1h, pinged20min, boss } }
let missedWindowDashboards = {};

// everyoneWarnings: { [key]: { msg, content, repinTimer, deleteTimer } }
let everyoneWarnings = {};

let adminLogs  = [];
let undoStack  = [];

const MAX_DISCORD_BACKUPS = 7;
let backupMessages  = [];
let backupSlotIndex = 0;
let logMessage      = null;

const REPIN_AFTER_MS = 30 * 1000;
let lastRepinTime    = Date.now();

const EVERYONE_WARNING_LIFESPAN_MS    = 10 * 60 * 1000;
const EVERYONE_REPIN_BEFORE_EXPIRE_MS =  1 * 60 * 1000;

// Tracks the last-known ordered list of window message IDs (spawn + missed)
// so we can detect when reordering is needed without rebuilding every tick.
let lastWindowOrder = [];

// Prevents concurrent reorder operations from stepping on each other.
let reorderInProgress = false;

// =====================
// BOSSES
// =====================
function buildBosses() {
  const bosses = [];
  for (let i = 1; i <= 3; i++) bosses.push({ id: `lorencia_${i}`, name: `Kharzul #${i}`, type: "kharzul" });
  for (let i = 1; i <= 3; i++) bosses.push({ id: `davias_${i}`,   name: `Vescrya #${i}`, type: "vescrya" });
  for (let i = 1; i <= 2; i++) bosses.push({ id: `crywolf_${i}`,  name: `Muggron #${i} Crywolf`, type: "muggron" });
  for (let i = 1; i <= 2; i++) bosses.push({ id: `barracks_${i}`, name: `Muggron #${i} Barracks`, type: "muggron" });
  return bosses;
}
const BOSSES = buildBosses();

const TRACKED_BOSS_TYPES = new Set(["kharzul", "vescrya"]);

// =====================
// FIXED EVENTS
// =====================
const FIXED_EVENTS = [
  {
    name: "🟡 Golden Invasion",
    times: ["00:36","04:36","08:36","12:36","16:36","20:36"],
    warnMinutes: 5,
  },
  {
    name: "🧙 White Wizard",
    times: ["09:45","12:45","15:45","18:45"],
    warnMinutes: 5,
  },
  {
    name: "💀 Death King",
    times: ["21:45","00:45","03:45","06:45"],
    warnMinutes: 5,
  },
  {
    name: "⚡ Zaikan",
    times: ["00:55","06:55","12:55","18:55"],
    warnMinutes: 5,
  },
  {
    name: "🐉 Red Dragon",
    times: ["08:00","20:00"],
    warnMinutes: 5,
  },
  {
    name: "🎅 Cursed Santa",
    times: ["02:35","08:35","14:35","20:35"],
    warnMinutes: 5,
  },
  {
    name: "🏰 Chaos Castle",
    times: ["13:55","17:55","21:55","01:55","05:55","09:55"],
    warnMinutes: 5,
  },
  {
    name: "⚔️ Battle Royale",
    times: ["02:00","08:00","14:00","20:00","23:00"],
    warnMinutes: 10,
    extraNote: "⚠️ Registration opens **5 minutes before** the event starts — be ready!",
  },
];

// eventPingedKeys: Set of keys we've already warned about this session.
// Key format: "EventName|HH:MM|YYYY-MM-DD" (date in server TZ).
const eventPingedKeys = new Set();

// =====================
// TIMEZONE HELPER
// =====================
const SERVER_TZ = "Europe/Amsterdam";

function getAmsterdamOffsetMs(date) {
  const utcStr = date.toLocaleString("en-US", { timeZone: "UTC" });
  const tzStr  = date.toLocaleString("en-US", { timeZone: SERVER_TZ });
  return new Date(tzStr) - new Date(utcStr);
}

function parseServerTime(h, m) {
  const now     = new Date();
  const dateStr = now.toLocaleDateString("en-CA", { timeZone: SERVER_TZ });
  const candidate = new Date(`${dateStr}T${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}:00`);
  const tzOffset  = getAmsterdamOffsetMs(candidate);
  const utcMs     = candidate.getTime() - tzOffset;
  const kill      = new Date(utcMs);
  if (kill > now) kill.setDate(kill.getDate() - 1);
  return kill;
}

function toServerTimeStr(ms) {
  return new Date(ms).toLocaleTimeString("en-GB", {
    hour: "2-digit", minute: "2-digit",
    timeZone: SERVER_TZ, hour12: false
  });
}

function toServerDateTimeStr(ms) {
  return new Date(ms).toLocaleString("en-GB", {
    timeZone: SERVER_TZ, hour12: false,
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    day: "2-digit", month: "2-digit", year: "numeric"
  });
}

// Returns the UTC ms of the NEXT occurrence of HH:MM (server TZ) strictly after afterMs.
function nextOccurrenceMs(hhmm, afterMs) {
  const [h, m]  = hhmm.split(":").map(Number);
  const afterDt = new Date(afterMs);
  for (let dayOffset = 0; dayOffset <= 1; dayOffset++) {
    const base = new Date(afterDt);
    base.setDate(base.getDate() + dayOffset);
    const dateStr   = base.toLocaleDateString("en-CA", { timeZone: SERVER_TZ });
    const candidate = new Date(`${dateStr}T${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}:00`);
    const tzOffset  = getAmsterdamOffsetMs(candidate);
    const utcMs     = candidate.getTime() - tzOffset;
    if (utcMs >= afterMs) return utcMs;
  }
  const afterDt2   = new Date(afterMs);
  afterDt2.setDate(afterDt2.getDate() + 1);
  const dateStr2   = afterDt2.toLocaleDateString("en-CA", { timeZone: SERVER_TZ });
  const candidate2 = new Date(`${dateStr2}T${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}:00`);
  const tzOffset2  = getAmsterdamOffsetMs(candidate2);
  return candidate2.getTime() - tzOffset2;
}

// =====================
// SAVE / LOAD
// =====================
function load() {
  if (fs.existsSync("data.json")) {
    data = JSON.parse(fs.readFileSync("data.json", "utf8"));
  }
  if (!data.kills) data.kills = {};
}

function save() {
  fs.writeFileSync("data.json.tmp", JSON.stringify(data, null, 2));
  fs.renameSync("data.json.tmp", "data.json");
}

// =====================
// REDEPLOY RECOVERY
// =====================
async function recoverFromDiscordBackup() {
  if (!DATA_BACKUP_CHANNEL_ID) return false;

  const now = Date.now();
  const shouldRecover = (() => {
    if (!fs.existsSync("data.json")) return true;
    try {
      const d = JSON.parse(fs.readFileSync("data.json", "utf8"));
      if (!d.kills || Object.keys(d.kills).length === 0) return true;
      return Object.values(d.kills).every(e => e.respawnTime < now - 8 * 60 * 60 * 1000);
    } catch { return true; }
  })();

  if (!shouldRecover) {
    console.log("[Recovery] Local data.json is valid — skipping Discord recovery.");
    return false;
  }

  console.log("[Recovery] Local data is absent/empty/stale — scanning Discord for latest backup...");
  try {
    const backupCh = await client.channels.fetch(DATA_BACKUP_CHANNEL_ID);
    const fetched  = await backupCh.messages.fetch({ limit: 100 });
    const candidates = [...fetched.values()].filter(m =>
      m.author.id === client.user.id &&
      m.attachments.size > 0 &&
      [...m.attachments.values()].some(a => a.name && a.name.endsWith(".json"))
    );

    if (!candidates.length) { console.warn("[Recovery] No backup messages found."); return false; }

    const best = candidates.sort((a, b) => b.editedTimestamp - a.editedTimestamp)[0];
    const attachment = [...best.attachments.values()].find(a => a.name.endsWith(".json"));

    const response = await fetch(attachment.url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const json = await response.json();
    if (!json.kills) throw new Error("Backup JSON has no 'kills' field");

    const filtered = {};
    for (const [id, entry] of Object.entries(json.kills)) {
      if (entry.respawnTime >= now - 8 * 60 * 60 * 1000) filtered[id] = entry;
    }

    data = { kills: filtered };
    save();
    console.log(`[Recovery] Restored ${Object.keys(filtered).length} active timer(s) from Discord backup.`);
    return true;
  } catch (err) {
    console.error("[Recovery] Failed:", err);
    return false;
  }
}

// =====================
// BACKUP — local
// =====================
const BACKUP_INTERVAL_MS = 60 * 60 * 1000;
const MAX_LOCAL_BACKUPS  = 48;

function saveLocalBackup() {
  if (!fs.existsSync("backups")) fs.mkdirSync("backups");
  const stamp    = new Date().toISOString().replace(/:/g, "-").replace("T", "_").slice(0, 16);
  const filename = `backups/data.backup-${stamp}.json`;
  fs.writeFileSync(filename, JSON.stringify(data, null, 2));
  const files = fs.readdirSync("backups")
    .filter(f => f.startsWith("data.backup-") && f.endsWith(".json")).sort();
  if (files.length > MAX_LOCAL_BACKUPS)
    files.slice(0, files.length - MAX_LOCAL_BACKUPS).forEach(f => fs.unlinkSync(`backups/${f}`));
  return filename;
}

// =====================
// BACKUP — Discord slots
// =====================
function buildBackupEmbed(slotNumber, takenAt) {
  const lines = BOSSES.map(b => {
    const e = data.kills[b.id];
    if (!e) return `• **${b.name}**: —`;
    return `• **${b.name}**: by ${e.lastKiller} — kill: ${toServerDateTimeStr(e.killTime)} — respawn: ${toServerDateTimeStr(e.respawnTime)}`;
  });
  return new EmbedBuilder()
    .setTitle(`💾 Backup Slot ${slotNumber} / ${MAX_DISCORD_BACKUPS}`)
    .setColor(0x2b2d31)
    .setDescription(lines.join("\n"))
    .setFooter({ text: `Last updated: ${toServerDateTimeStr(takenAt || Date.now())} (server time)` });
}

async function initBackupMessages(backupChannel) {
  backupMessages  = [];
  backupSlotIndex = 0;

  try {
    const fetched   = await backupChannel.messages.fetch({ limit: 100 });
    const existing  = [...fetched.values()]
      .filter(m => m.author.id === client.user.id)
      .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
      .slice(-MAX_DISCORD_BACKUPS);

    if (existing.length === MAX_DISCORD_BACKUPS) {
      for (let i = 0; i < MAX_DISCORD_BACKUPS; i++) {
        const isoStamp = new Date().toISOString().replace(/:/g, "-").slice(0, 16);
        try {
          await existing[i].edit({
            embeds: [buildBackupEmbed(i + 1, Date.now())],
            files: [{ attachment: Buffer.from(JSON.stringify(data, null, 2), "utf8"), name: `backup-slot${i + 1}-${isoStamp}.json` }]
          });
        } catch (e) { console.warn(`[Backup] Could not re-edit slot ${i + 1}:`, e.message); }
        backupMessages.push(existing[i]);
      }
      backupSlotIndex = 0;
      console.log(`[Backup] Reused ${MAX_DISCORD_BACKUPS} existing slot messages.`);
      return;
    }
  } catch (err) {
    console.warn("[Backup] Could not fetch existing messages, posting fresh slots:", err.message);
  }

  for (let i = 1; i <= MAX_DISCORD_BACKUPS; i++) {
    const isoStamp = new Date().toISOString().replace(/:/g, "-").slice(0, 16);
    const msg = await backupChannel.send({
      embeds: [buildBackupEmbed(i, null)],
      files: [{ attachment: Buffer.from(JSON.stringify(data, null, 2), "utf8"), name: `backup-slot${i}-${isoStamp}.json` }],
      flags: MessageFlags.SuppressNotifications
    });
    backupMessages.push(msg);
  }
  console.log(`[Backup] ${MAX_DISCORD_BACKUPS} fresh slots posted.`);
}

async function updateDiscordBackupSlot() {
  if (!backupMessages.length) return;
  const slot       = backupSlotIndex % MAX_DISCORD_BACKUPS;
  const slotNumber = slot + 1;
  const isoStamp   = new Date().toISOString().replace(/:/g, "-").slice(0, 16);
  try {
    await backupMessages[slot].edit({
      embeds: [buildBackupEmbed(slotNumber, Date.now())],
      files: [{ attachment: Buffer.from(JSON.stringify(data, null, 2), "utf8"), name: `backup-slot${slotNumber}-${isoStamp}.json` }]
    });
    console.log(`[Backup] Slot ${slotNumber} updated.`);
  } catch (err) { console.error(`[Backup] Slot ${slotNumber} edit failed:`, err); }
  backupSlotIndex = (backupSlotIndex + 1) % MAX_DISCORD_BACKUPS;
}

async function runBackup() {
  try { console.log(`[Backup] ${saveLocalBackup()}`); await updateDiscordBackupSlot(); }
  catch (err) { console.error("[Backup]", err); }
}

function startBackupLoop() {
  const now = new Date();
  const msUntilNextHour = BACKUP_INTERVAL_MS -
    (now.getMinutes() * 60000 + now.getSeconds() * 1000 + now.getMilliseconds());
  console.log(`[Backup] First in ${Math.round(msUntilNextHour / 60000)}m, then hourly.`);
  setTimeout(() => { runBackup(); setInterval(runBackup, BACKUP_INTERVAL_MS); }, msUntilNextHour);
}

// =====================
// PERSISTENT LOG MESSAGE
// =====================
function buildLogEmbed() {
  const recent = adminLogs.slice(0, 20);
  const description = recent.length
    ? recent.map(l => `\`${toServerDateTimeStr(l.time)}\` — **${l.user}** — ${l.action}`).join("\n")
    : "No actions logged yet.";
  return new EmbedBuilder()
    .setTitle("📜 Action Log (Last 20)")
    .setDescription(description)
    .setColor(0x5865f2)
    .setFooter({ text: "Auto-updates on every action" });
}

async function initLogMessage(channel) {
  logMessage = await channel.send({ embeds: [buildLogEmbed()], flags: MessageFlags.SuppressNotifications });
  console.log("[Log] Log message posted.");
}

async function updateLogMessage() {
  if (!logMessage) return;
  try { await logMessage.edit({ embeds: [buildLogEmbed()] }); }
  catch (err) { console.error("[Log] Update failed:", err); }
}

// =====================
// FORMAT
// =====================
function format(ms) {
  if (ms <= 0) return "NOW";
  const m = Math.floor(ms / 60000);
  const h = Math.floor(m / 60);
  return h > 0 ? `${h}h ${m % 60}m` : `${m}m`;
}

// =====================
// LOGGING
// =====================
function log(user, actionType) {
  adminLogs.unshift({ user: user.username, action: actionType, time: Date.now() });
  if (adminLogs.length > 200) adminLogs.pop();
  updateLogMessage();
}

// =====================
// UNDO
// =====================
function snapshot() {
  undoStack.push(JSON.parse(JSON.stringify(data)));
  if (undoStack.length > MAX_UNDO) undoStack.shift();
}

function undo() {
  if (!undoStack.length) return false;
  data = undoStack.pop();
  save();
  return true;
}

// =====================
// ANNOUNCE HELPERS
// =====================
async function announceKill(channel, user, action, extra = "") {
  const content = `⚔️ **${user.username}** ${action} — ${toServerDateTimeStr(Date.now())} (server time)${extra ? `\n${extra}` : ""}`;
  await channel.send({ content, flags: MessageFlags.SuppressNotifications });
  forwardToLogChannel(content);
}

async function announceAdmin(channel, user, action) {
  const content = `📢 **${user.username}** ${action} — ${toServerDateTimeStr(Date.now())} (server time)`;
  const msg     = await channel.send({ content, flags: MessageFlags.SuppressNotifications });
  forwardToLogChannel(content);
  setTimeout(() => { msg.delete().catch(() => {}); }, 10 * 60 * 1000);
}

async function forwardToLogChannel(content) {
  if (!LOG_CHANNEL_ID) return;
  if (LOG_CHANNEL_ID === CHANNEL_ID) return;
  try {
    const logCh = await client.channels.fetch(LOG_CHANNEL_ID);
    await logCh.send({ content, flags: MessageFlags.SuppressNotifications });
  } catch (err) { console.error("[Log Channel]", err); }
}

// =====================
// @EVERYONE WARNINGS — self-repinning
// =====================
async function postEveryoneWarning(channel, key, content) {
  await clearEveryoneWarning(key);

  let msg;
  try { msg = await channel.send({ content }); }
  catch (err) { console.error("[Warning] Failed to post @everyone:", err); return; }

  forwardToLogChannel(content);
  scheduleEveryoneWarningCycle(channel, key, content, msg);
}

function scheduleEveryoneWarningCycle(channel, key, content, msg) {
  const repinDelay = EVERYONE_WARNING_LIFESPAN_MS - EVERYONE_REPIN_BEFORE_EXPIRE_MS;

  const repinTimer = setTimeout(async () => {
    if (!everyoneWarnings[key]) return;
    everyoneWarnings[key].msg.delete().catch(() => {});

    let newMsg;
    try { newMsg = await channel.send({ content }); }
    catch { delete everyoneWarnings[key]; return; }

    everyoneWarnings[key].msg = newMsg;
    scheduleEveryoneWarningCycle(channel, key, content, newMsg);
  }, repinDelay);

  const deleteTimer = setTimeout(() => {
    if (!everyoneWarnings[key]) return;
    everyoneWarnings[key].msg.delete().catch(() => {});
    delete everyoneWarnings[key];
  }, EVERYONE_WARNING_LIFESPAN_MS);

  everyoneWarnings[key] = { msg, content, repinTimer, deleteTimer };
}

async function clearEveryoneWarning(key) {
  const w = everyoneWarnings[key];
  if (!w) return;
  clearTimeout(w.repinTimer);
  clearTimeout(w.deleteTimer);
  w.msg.delete().catch(() => {});
  delete everyoneWarnings[key];
}

// =====================
// SPAWN WINDOW EMBEDS & COMPONENTS
// =====================
function buildSpawnWindowEmbed(boss, windowEnd) {
  const remaining = windowEnd - Date.now();
  const tsEnd     = Math.floor(windowEnd / 1000);
  const desc = remaining > 0
    ? `🔥 Boss: **${boss.name}**\n⏳ Time left: **${format(remaining)}**\n🕒 Closes: ${toServerTimeStr(windowEnd)} (server) — <t:${tsEnd}:t> (your time)`
    : `🔥 Boss: **${boss.name}**\n⌛ Window has closed — log the kill or wait for next respawn`;
  return new EmbedBuilder()
    .setTitle(`⚠️ ${boss.name} SPAWN WINDOW ACTIVE`)
    .setColor(0xffcc00)
    .setDescription(desc);
}

function buildSpawnWindowComponents(id) {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("window_kill_" + id).setLabel("💀 Killed").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("window_settime_" + id).setLabel("⏱️ Set Time").setStyle(ButtonStyle.Secondary)
  )];
}

// Creates a spawn window message. Safe to call multiple times — no-ops if already exists.
async function createSpawnWindow(boss, id, channel, windowEnd) {
  if (spawnWindowMessages[id]) return;

  const msg = await channel.send({
    embeds: [buildSpawnWindowEmbed(boss, windowEnd)],
    components: buildSpawnWindowComponents(id),
    flags: MessageFlags.SuppressNotifications
  });

  spawnWindowMessages[id] = { msg, windowEnd, boss };
}

// =====================
// MISSED WINDOW / AUTO-ADVANCE
//
// Timeline per kill:
//   t+0h      kill logged
//   t+7h      respawn cooldown ends -> 1h spawn window opens
//   t+8h      spawn window closes (no kill = missed)
//   t+8h+10m  missedHandled fires -> register metadata, advance timer by 7h
//             new respawnTime = old_respawnTime + 7h
//             nextWindowStart = new respawnTime (7h from now)
//             nextWindowEnd   = new respawnTime + 2h (9h from now)
//   visibleAfter = nextWindowStart - 15min
//   The missed window tracker card only appears in chat once visibleAfter
//   is reached, so it doesn't clutter chat for 7 hours.
// =====================
function handleMissedWindow(boss, id) {
  const e = data.kills[id];
  if (!e) return;

  console.log(`[MissedWindow] No kill recorded for ${boss.name} — auto-advancing by 7h`);

  snapshot();
  e.respawnTime = e.respawnTime + 7 * 60 * 60 * 1000;
  e.killTime    = e.respawnTime - 7 * 60 * 60 * 1000;
  save();

  spawnWarnings[id] = { warned5: false, warned20: false, windowCreated: false, missedHandled: false };

  if (missedWindowDashboards[id]) {
    missedWindowDashboards[id].msg && missedWindowDashboards[id].msg.delete().catch(() => {});
    delete missedWindowDashboards[id];
  }

  const nextWindowStart = e.respawnTime;
  const nextWindowEnd   = e.respawnTime + 2 * 60 * 60 * 1000;
  const visibleAfter    = nextWindowEnd + 15 * 60 * 1000;   // show 15 min after window closes (grace period)

  // Register metadata only — no Discord message posted yet.
  // fullRepin will post the card once Date.now() >= visibleAfter.
  missedWindowDashboards[id] = {
    msg: null,
    nextWindowStart,
    nextWindowEnd,
    visibleAfter,
    pingedStart: false,
    pinged1h:    false,
    pinged20min: false,
    boss,
    lastRepinTime: 0,
  };

  // Signal that the desired window set has changed so the main loop
  // will trigger a fullRepin as soon as visibleAfter is reached.
  lastWindowOrder = [];
}

function buildMissedWindowEmbed(boss, windowStart, windowEnd) {
  const now        = Date.now();
  const untilStart = windowStart - now;
  const untilEnd   = windowEnd   - now;

  let statusLine;
  if (untilStart > 0) {
    statusLine = `⏳ Next possible window in: **${format(untilStart)}**\n🕒 Opens at: ${toServerTimeStr(windowStart)} (server)`;
  } else if (untilEnd > 0) {
    statusLine = `🟡 **WINDOW OPEN** — closes in: **${format(untilEnd)}**\n🕒 Opened at: ${toServerTimeStr(windowStart)} (server)`;
  } else {
    statusLine = `⚠️ Window has closed with no kill recorded.`;
  }

  return new EmbedBuilder()
    .setTitle(`🔶 ${boss.name} — Missed Window Tracker`)
    .setColor(0xff6600)
    .setDescription(
      `${statusLine}\n\n` +
      `> ⚠️ **This timer might be incorrect and/or it will take longer for respawn.**\n` +
      `> The previous window passed without a kill being logged.`
    )
    .setFooter({ text: `Auto-updating | Window: ${toServerTimeStr(windowStart)} – ${toServerTimeStr(windowEnd)} (server)` });
}

// Handles only @everyone pings for missed windows.
// Message posting/editing is fully managed by fullRepin and the main loop's
// in-place edit step — this function never touches Discord messages.
function tickMissedWindowPings(channel) {
  const now = Date.now();

  for (const id in missedWindowDashboards) {
    const w = missedWindowDashboards[id];
    const untilStart = w.nextWindowStart - now;
    const untilEnd   = w.nextWindowEnd   - now;

    // Trigger a fullRepin once the tracker becomes visible (15 min before window)
    if (!w.visible && now >= w.visibleAfter) {
      w.visible = true;
      lastWindowOrder = []; // causes fullRepin on next tick
    }

    if (!w.pingedStart && untilStart <= 0 && untilEnd > 0) {
      w.pingedStart = true;
      const content =
        `@everyone 🔶 **${w.boss.name}** next possible spawn window is now open!\n` +
        `⚠️ This timer might be incorrect — boss may take longer to respawn.\n` +
        `Window closes in **${format(untilEnd)}** (${toServerTimeStr(w.nextWindowEnd)} server time)`;
      channel.send(content);
      forwardToLogChannel(content);
    }

    if (!w.pinged1h && untilEnd > 0 && untilEnd <= 60 * 60 * 1000) {
      w.pinged1h = true;
      const content =
        `@everyone ⏳ **${w.boss.name}** missed-window: **1 hour remaining** in the spawn window!\n` +
        `⚠️ This timer might be incorrect.`;
      channel.send(content);
      forwardToLogChannel(content);
    }

    if (!w.pinged20min && untilEnd > 0 && untilEnd <= 20 * 60 * 1000) {
      w.pinged20min = true;
      const content =
        `@everyone ⚠️ **${w.boss.name}** missed-window: **20 minutes remaining** in the spawn window!`;
      channel.send(content);
      forwardToLogChannel(content);
    }
  }
}

// =====================
// FIXED EVENT WARNINGS
// FIX: Use a ±30s window around the event to tolerate tick jitter and
//      brief bot downtime. Previously only fired when timeUntil > 0, which
//      meant a single missed tick permanently skipped the warning.
// =====================
async function checkFixedEvents(channel) {
  const now = Date.now();

  for (const ev of FIXED_EVENTS) {
    for (const hhmm of ev.times) {
      const warnMs = ev.warnMinutes * 60 * 1000;

      // Find the most recent past occurrence of this event time (could be
      // today or yesterday in server TZ) and also the next future one.
      // We want to fire if now falls in [eventMs - warnMs, eventMs + 30s].
      // nextOccurrenceMs returns the next time >= now, so to get the
      // "current or most recent" occurrence we look one period back.
      const nextMs = nextOccurrenceMs(hhmm, now);
      // Previous occurrence = nextMs minus one day... but events repeat at
      // fixed times, not every 24h uniformly. Simpler: also check nextMs
      // itself (if it's in warn range) and the occurrence just before now.
      const prevMs = nextOccurrenceMs(hhmm, now - 24 * 60 * 60 * 1000);

      for (const eventMs of [prevMs, nextMs]) {
        const timeUntil = eventMs - now;

        // Fire if we are within the warn window, including up to 30s AFTER
        // the warning should have fired (covers tick jitter / brief restarts).
        if (timeUntil > warnMs || timeUntil < -30 * 1000) continue;

        // Key: use the event's own UTC timestamp (rounded to the minute) so
        // it's stable regardless of server TZ date boundaries.
        const roundedEventMinute = Math.round(eventMs / 60000);
        const key = `${ev.name}|${hhmm}|${roundedEventMinute}`;
        if (eventPingedKeys.has(key)) continue;
        eventPingedKeys.add(key);

        const eventTimeStr = toServerTimeStr(eventMs);
        const tsEvent      = Math.floor(eventMs / 1000);
        let msg =
          `@everyone ⏰ **${ev.name}** starts in **${ev.warnMinutes} minutes**!\n` +
          `🕒 ${eventTimeStr} (server time) — <t:${tsEvent}:t> (your local time)`;
        if (ev.extraNote) msg += `\n${ev.extraNote}`;

        channel.send(msg).then(m => {
          setTimeout(() => m.delete().catch(() => {}), 5 * 60 * 1000);
        }).catch(() => {});
        forwardToLogChannel(msg);

        // Prune old keys to prevent unbounded growth (keep ~last 2 days).
        if (eventPingedKeys.size > 1000) {
          const cutoff = Math.round((now - 48 * 60 * 60 * 1000) / 60000);
          for (const k of eventPingedKeys) {
            const parts = k.split("|");
            const keyMinute = Number(parts[2]);
            if (!isNaN(keyMinute) && keyMinute < cutoff) eventPingedKeys.delete(k);
          }
        }
      }
    }
  }
}

// =====================
// DASHBOARD EMBED
// =====================
function buildEmbed() {
  const now   = Date.now();
  const embed = new EmbedBuilder()
    .setTitle("🔥 LIVE MU TRACKER")
    .setColor(0xffaa00)
    .setFooter({ text: "Auto-updates every 5s" });

  const bosses = BOSSES.map(b => {
    const e = data.kills[b.id];
    if (!e) return { name: b.name, timeLeft: 0, text: "🟢 READY\n👤 None", isBroken: false };

    const cooldown   = e.respawnTime - now;
    const windowEnd  = e.respawnTime + 60 * 60 * 1000;
    const windowLeft = windowEnd - now;
    let text, isBroken = false;

    if (cooldown <= 0 && windowLeft > 0) {
      const tsRespawn = Math.floor(e.respawnTime / 1000);
      text = `🟢 WINDOW — ⏳ ${format(windowLeft)}\n🕒 Was due: ${toServerTimeStr(e.respawnTime)} (server) — <t:${tsRespawn}:t> (your time)\n👤 ${e.lastKiller}`;
    } else if (windowLeft <= 0) {
      const nextWindowOpen  = e.respawnTime + 60 * 60 * 1000;
      const nextWindowClose = e.respawnTime + 2 * 60 * 60 * 1000;
      const tsOpen  = Math.floor(nextWindowOpen / 1000);
      const tsClose = Math.floor(nextWindowClose / 1000);
      const nextLine = nextWindowClose > now
        ? `🔄 Next possible: <t:${tsOpen}:t> — <t:${tsClose}:t> (your time)`
        : `🔄 Next window also passed — update manually`;
      text = `⚠️ Timer possibly wrong\n🕒 Last known respawn: ${toServerTimeStr(e.respawnTime)} (server)\n${nextLine}\n👤 ${e.lastKiller}`;
      isBroken = true;
    } else {
      const tsRespawn = Math.floor(e.respawnTime / 1000);
      text = `🔴 ${format(cooldown)}\n🕒 ${toServerTimeStr(e.respawnTime)} (server) — <t:${tsRespawn}:t> (your time)\n👤 ${e.lastKiller}`;
    }

    return { name: b.name, timeLeft: Math.max(cooldown, windowLeft), text, isBroken };
  });

  bosses.sort((a, b) => {
    if (a.isBroken && !b.isBroken) return 1;
    if (!a.isBroken && b.isBroken) return -1;
    return a.timeLeft - b.timeLeft;
  });

  for (const b of bosses) embed.addFields({ name: `• ${b.name}`, value: b.text });
  return embed;
}

// =====================
// BUTTONS
// =====================
function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function buildButtons() {
  const rows = [];
  for (const group of chunk(BOSSES, 5)) {
    const row = new ActionRowBuilder();
    for (const b of group)
      row.addComponents(new ButtonBuilder().setCustomId("kill_" + b.id).setLabel(b.name.slice(0, 20)).setStyle(ButtonStyle.Primary));
    rows.push(row);
  }
  rows.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("insert_time").setLabel("📝 Insert").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("reset_all").setLabel("🧹 Reset").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("undo").setLabel("↩️ Undo").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("show_logs").setLabel("📜 Logs").setStyle(ButtonStyle.Secondary)
  ));
  return rows;
}

// =====================
// WINDOW ORDER HELPERS
// =====================

// Returns sorted descriptors for all active spawn + missed windows.
// Spawn windows sort by windowEnd asc; missed windows always appear after
// spawn windows (sorted by nextWindowEnd asc among themselves).
function computeWindowOrder() {
  const now     = Date.now();
  const spawn   = [];
  const missed  = [];

  for (const id in spawnWindowMessages) {
    const w = spawnWindowMessages[id];
    spawn.push({ key: `spawn:${id}`, timeRemaining: w.windowEnd - now, type: "spawn", id });
  }
  for (const id in missedWindowDashboards) {
    const w = missedWindowDashboards[id];
    // Only include in ordering once the tracker is visible (15 min before window)
    if (now < w.visibleAfter) continue;
    missed.push({ key: `missed:${id}`, timeRemaining: w.nextWindowEnd - now, type: "missed", id });
  }

  spawn.sort((a, b) => a.timeRemaining - b.timeRemaining);
  missed.sort((a, b) => a.timeRemaining - b.timeRemaining);
  return [...spawn, ...missed];
}

// =====================
// ATOMIC FULL REPIN
// Deletes ALL managed messages (dashboard + all windows) and reposts them
// in the correct fixed order:  dashboard → spawn windows → missed windows.
// This is the only place that posts new messages, preventing any jiggle.
// =====================
async function fullRepin(channel) {
  if (reorderInProgress) return;
  reorderInProgress = true;
  try {
    const now = Date.now();

    // 1. Delete everything we own.
    if (dashboardMessage) { await dashboardMessage.delete().catch(() => {}); dashboardMessage = null; }
    for (const id of Object.keys(spawnWindowMessages)) {
      spawnWindowMessages[id].msg && spawnWindowMessages[id].msg.delete().catch(() => {});
      delete spawnWindowMessages[id];
    }
    for (const id of Object.keys(missedWindowDashboards)) {
      missedWindowDashboards[id].msg && missedWindowDashboards[id].msg.delete().catch(() => {});
      missedWindowDashboards[id].msg = null;
    }

    // 2. Post dashboard first.
    dashboardMessage = await channel.send({
      embeds: [buildEmbed()],
      components: buildButtons(),
      flags: MessageFlags.SuppressNotifications
    });
    lastRepinTime = now;

    // 3. Post windows in sorted order (spawn first, missed after).
    const entries = computeWindowOrder();
    for (const entry of entries) {
      if (entry.type === "spawn") {
        const boss = BOSSES.find(b => b.id === entry.id);
        if (!boss) continue;
        const e = data.kills[entry.id];
        if (!e) continue;
        const windowEnd = e.respawnTime + 60 * 60 * 1000;
        if (windowEnd + 25 * 60 * 1000 < now) continue;

        const msg = await channel.send({
          embeds: [buildSpawnWindowEmbed(boss, windowEnd)],
          components: buildSpawnWindowComponents(entry.id),
          flags: MessageFlags.SuppressNotifications
        });
        spawnWindowMessages[entry.id] = { msg, windowEnd, boss };

      } else if (entry.type === "missed") {
        const w = missedWindowDashboards[entry.id];
        if (!w) continue;
        if (now < w.visibleAfter) continue;           // not yet time to show it
        if (w.nextWindowEnd + 30 * 60 * 1000 < now) continue; // expired (30min after window closes)

        const msg = await channel.send({
          embeds: [buildMissedWindowEmbed(w.boss, w.nextWindowStart, w.nextWindowEnd)],
          components: [new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId("missed_kill_"    + entry.id).setLabel("💀 Killed").setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId("missed_settime_" + entry.id).setLabel("⏱️ Set Time").setStyle(ButtonStyle.Secondary)
          )],
          flags: MessageFlags.SuppressNotifications
        });
        missedWindowDashboards[entry.id].msg = msg;
        missedWindowDashboards[entry.id].lastRepinTime = now;
      }
    }

    lastWindowOrder = computeWindowOrder().map(e => e.key);
    console.log(`[Repin] Done. Order: dashboard → [${lastWindowOrder.join(", ")}]`);

  } catch (err) {
    console.error("[Repin] Error:", err);
  } finally {
    reorderInProgress = false;
  }
}

// =====================
// MAIN LOOP
//
// Design: every tick we only EDIT messages in place (cheap).
// A full atomic repin is triggered when:
//   a) the desired window order changes (new window opened/closed), OR
//   b) the dashboard is detected dead (deleted externally), OR
//   c) REPIN_AFTER_MS has elapsed (keeps everything at the bottom of chat).
// The liveness check for windows runs once per minute to catch manual deletes.
// =====================
let lastLivenessCheckTime = 0;
const LIVENESS_CHECK_INTERVAL = 60 * 1000;

function startLoop() {
  setInterval(async () => {
    if (!dashboardMessage) return;
    const channel = dashboardMessage.channel;
    const now = Date.now();

    // ── STEP 1: Expire stale window metadata (no API call) ──
    for (const id of Object.keys(spawnWindowMessages)) {
      if (spawnWindowMessages[id].windowEnd + 25 * 60 * 1000 < now) {
        spawnWindowMessages[id].msg && spawnWindowMessages[id].msg.delete().catch(() => {});
        delete spawnWindowMessages[id];
        lastWindowOrder = [];
      }
    }
    for (const id of Object.keys(missedWindowDashboards)) {
      if (missedWindowDashboards[id].nextWindowEnd + 30 * 60 * 1000 < now) {
        missedWindowDashboards[id].msg && missedWindowDashboards[id].msg.delete().catch(() => {});
        delete missedWindowDashboards[id];
        lastWindowOrder = [];
      }
    }

    // ── STEP 2: Warnings, missed-window pings, fixed events (no UI posts) ──
    checkWarnings(channel);
    tickMissedWindowPings(channel);
    await checkFixedEvents(channel);

    // ── STEP 3: Periodic liveness check for window messages (1/min) ──
    if (now - lastLivenessCheckTime >= LIVENESS_CHECK_INTERVAL) {
      lastLivenessCheckTime = now;
      let anyDead = false;
      for (const id of Object.keys(spawnWindowMessages)) {
        const alive = await spawnWindowMessages[id].msg.fetch().then(() => true).catch(() => false);
        if (!alive) { delete spawnWindowMessages[id]; anyDead = true; }
      }
      for (const id of Object.keys(missedWindowDashboards)) {
        const w = missedWindowDashboards[id];
        if (!w.msg) continue;
        const alive = await w.msg.fetch().then(() => true).catch(() => false);
        if (!alive) { w.msg = null; anyDead = true; }
      }
      if (anyDead) lastWindowOrder = [];
    }

    // ── STEP 4: Decide whether a full repin is needed ──
    const desired        = computeWindowOrder().map(e => e.key);
    const orderChanged   = JSON.stringify(desired) !== JSON.stringify(lastWindowOrder);
    const dashboardDead  = await dashboardMessage.fetch().then(() => false).catch(() => true);
    const repinDue       = now - lastRepinTime >= REPIN_AFTER_MS;

    if ((orderChanged || dashboardDead || repinDue) && !reorderInProgress) {
      await fullRepin(channel);
      return; // skip in-place edits this tick — messages were just posted fresh
    }

    // ── STEP 5: In-place edits (fast path — no repin needed) ──
    dashboardMessage.edit({ embeds: [buildEmbed()], components: buildButtons() }).catch(() => {});

    for (const id in spawnWindowMessages) {
      const w = spawnWindowMessages[id];
      w.msg.edit({
        embeds: [buildSpawnWindowEmbed(w.boss, w.windowEnd)],
        components: buildSpawnWindowComponents(id)
      }).catch(() => {});
    }

    for (const id in missedWindowDashboards) {
      const w = missedWindowDashboards[id];
      if (!w.msg) continue;
      w.msg.edit({ embeds: [buildMissedWindowEmbed(w.boss, w.nextWindowStart, w.nextWindowEnd)] }).catch(() => {});
    }

  }, TICK_RATE);
}

// =====================
// WARNING SYSTEM
// =====================
function checkWarnings(channel) {
  const now = Date.now();

  for (const b of BOSSES) {
    const e = data.kills[b.id];
    if (!e) continue;

    const cooldown   = e.respawnTime - now;
    const windowEnd  = e.respawnTime + 60 * 60 * 1000;
    const windowLeft = windowEnd - now;
    const timeSinceWindowExpired = now - windowEnd;

    if (!spawnWarnings[b.id])
      spawnWarnings[b.id] = { warned5: false, warned20: false, windowCreated: false, missedHandled: false };

    const w = spawnWarnings[b.id];

    // 5-minute spawn warning
    if (cooldown > 0 && cooldown <= 5 * 60 * 1000 && !w.warned5) {
      w.warned5 = true;
      postEveryoneWarning(channel, `${b.id}_5min`, `@everyone ⏳ **${b.name}** spawns in 5 minutes`);
    }

    // 20-minute window warning
    if (cooldown <= 0 && windowLeft > 2 * 60 * 1000 && windowLeft <= 20 * 60 * 1000 && !w.warned20) {
      w.warned20 = true;
      postEveryoneWarning(channel, `${b.id}_20min`, `@everyone ⚠️ **${b.name}** may spawn in 20 minutes`);
    }

    // Open spawn window embed
    if (cooldown <= 0 && windowLeft > 0 && !w.windowCreated) {
      w.windowCreated = true;
      createSpawnWindow(b, b.id, channel, windowEnd).then(() => {
        lastWindowOrder = [];
      });
    }

    // Auto-advance for tracked boss types (kharzul, vescrya)
    if (
      TRACKED_BOSS_TYPES.has(b.type) &&
      timeSinceWindowExpired >= 10 * 60 * 1000 &&
      !w.missedHandled
    ) {
      w.missedHandled = true;
      handleMissedWindow(b, b.id);
    }
  }
}

// =====================
// READY
// =====================
client.once(Events.ClientReady, async () => {
  console.log("Bot online");
  load();

  if (await recoverFromDiscordBackup())
    console.log("[Recovery] Timers restored.");

  const channel = await client.channels.fetch(CHANNEL_ID);

  await initLogMessage(channel);

  if (DATA_BACKUP_CHANNEL_ID) {
    try { await initBackupMessages(await client.channels.fetch(DATA_BACKUP_CHANNEL_ID)); }
    catch (err) { console.error("[Backup] Could not fetch DATA_BACKUP_CHANNEL_ID, falling back to main channel:", err); await initBackupMessages(channel); }
  } else {
    await initBackupMessages(channel);
  }

  dashboardMessage = await channel.send({
    embeds: [buildEmbed()],
    components: buildButtons(),
    flags: MessageFlags.SuppressNotifications
  });
  lastRepinTime = Date.now();

  startLoop();
  startBackupLoop();

  setTimeout(() => runBackup().catch(err => console.error("[Backup] Startup backup failed:", err)), 5000);
});

// =====================
// INTERACTIONS
// =====================
client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isButton() && !interaction.isStringSelectMenu() && !interaction.isModalSubmit()) return;

  // ── KILL BUTTON ──────────────────────────────────────────────────────────
  if (interaction.isButton() && interaction.customId.startsWith("kill_")) {
    snapshot();
    const id          = interaction.customId.replace("kill_", "");
    const boss        = BOSSES.find(b => b.id === id);
    const now         = Date.now();
    const respawnTime = now + 7 * 60 * 60 * 1000;

    data.kills[id] = { killTime: now, respawnTime, lastKiller: interaction.user.username };
    save();
    log(interaction.user, `KILLED ${boss.name} — kill: ${toServerDateTimeStr(now)} — respawn: ${toServerDateTimeStr(respawnTime)}`);
    spawnWarnings[id] = { warned5: false, warned20: false, windowCreated: false, missedHandled: false };
    await clearEveryoneWarning(`${id}_5min`);
    await clearEveryoneWarning(`${id}_20min`);
    if (missedWindowDashboards[id]) {
      missedWindowDashboards[id].msg && missedWindowDashboards[id].msg.delete().catch(() => {});
      delete missedWindowDashboards[id];
    }
    lastWindowOrder = [];

    await announceKill(interaction.channel, interaction.user, `killed **${boss.name}**`,
      `🕒 Kill: ${toServerDateTimeStr(now)} — 🔄 Respawn: ${toServerDateTimeStr(respawnTime)}`);
    return interaction.deferUpdate();
  }

  // ── WINDOW KILL ───────────────────────────────────────────────────────────
  if (interaction.isButton() && interaction.customId.startsWith("window_kill_")) {
    snapshot();
    const id          = interaction.customId.replace("window_kill_", "");
    const boss        = BOSSES.find(b => b.id === id);
    const now         = Date.now();
    const respawnTime = now + 7 * 60 * 60 * 1000;

    if (spawnWindowMessages[id]) {
      spawnWindowMessages[id].msg && spawnWindowMessages[id].msg.delete().catch(() => {});
      delete spawnWindowMessages[id];
    }
    if (missedWindowDashboards[id]) {
      missedWindowDashboards[id].msg && missedWindowDashboards[id].msg.delete().catch(() => {});
      delete missedWindowDashboards[id];
    }

    data.kills[id] = { killTime: now, respawnTime, lastKiller: interaction.user.username };
    save();
    log(interaction.user, `WINDOW KILL ${boss.name} — kill: ${toServerDateTimeStr(now)} — respawn: ${toServerDateTimeStr(respawnTime)}`);
    spawnWarnings[id] = { warned5: false, warned20: false, windowCreated: false, missedHandled: false };
    await clearEveryoneWarning(`${id}_5min`);
    await clearEveryoneWarning(`${id}_20min`);
    lastWindowOrder = [];

    await announceKill(interaction.channel, interaction.user, `killed **${boss.name}** (window kill)`,
      `🕒 Kill: ${toServerDateTimeStr(now)} — 🔄 Respawn: ${toServerDateTimeStr(respawnTime)}`);
    return interaction.deferUpdate();
  }

  // ── WINDOW SET TIME — modal ───────────────────────────────────────────────
  if (interaction.isButton() && interaction.customId.startsWith("window_settime_")) {
    const id   = interaction.customId.replace("window_settime_", "");
    const boss = BOSSES.find(b => b.id === id);
    log(interaction.user, `Opened set-time modal for ${boss.name} (window)`);
    const modal = new ModalBuilder().setCustomId("window_killtime_" + id).setTitle(`Set Kill Time — ${boss.name}`);
    modal.addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId("time").setLabel("HH:MM (24h, server time)").setStyle(TextInputStyle.Short)
    ));
    return interaction.showModal(modal);
  }

  // ── WINDOW SET TIME — submit ──────────────────────────────────────────────
  if (interaction.isModalSubmit() && interaction.customId.startsWith("window_killtime_")) {
    snapshot();
    const id          = interaction.customId.replace("window_killtime_", "");
    const boss        = BOSSES.find(b => b.id === id);
    const [h, m]      = interaction.fields.getTextInputValue("time").split(":").map(Number);
    const kill        = parseServerTime(h, m);
    const respawnTime = kill.getTime() + 7 * 60 * 60 * 1000;

    if (spawnWindowMessages[id]) {
      spawnWindowMessages[id].msg && spawnWindowMessages[id].msg.delete().catch(() => {});
      delete spawnWindowMessages[id];
    }
    if (missedWindowDashboards[id]) {
      missedWindowDashboards[id].msg && missedWindowDashboards[id].msg.delete().catch(() => {});
      delete missedWindowDashboards[id];
    }

    data.kills[id] = { killTime: kill.getTime(), respawnTime, lastKiller: interaction.user.username };
    save();
    log(interaction.user, `MANUAL SET (window) ${boss.name} — kill: ${toServerDateTimeStr(kill.getTime())} — respawn: ${toServerDateTimeStr(respawnTime)}`);
    spawnWarnings[id] = { warned5: false, warned20: false, windowCreated: false, missedHandled: false };
    await clearEveryoneWarning(`${id}_5min`);
    await clearEveryoneWarning(`${id}_20min`);
    lastWindowOrder = [];

    await announceKill(interaction.channel, interaction.user, `manually set **${boss.name}** kill time (from window)`,
      `🕒 Kill: ${toServerDateTimeStr(kill.getTime())} — 🔄 Respawn: ${toServerDateTimeStr(respawnTime)}`);
    return interaction.deferUpdate();
  }

  // ── MISSED WINDOW — Kill button ───────────────────────────────────────────
  if (interaction.isButton() && interaction.customId.startsWith("missed_kill_")) {
    snapshot();
    const id          = interaction.customId.replace("missed_kill_", "");
    const boss        = BOSSES.find(b => b.id === id);
    const now         = Date.now();
    const respawnTime = now + 7 * 60 * 60 * 1000;

    if (missedWindowDashboards[id]) {
      missedWindowDashboards[id].msg && missedWindowDashboards[id].msg.delete().catch(() => {});
      delete missedWindowDashboards[id];
    }

    data.kills[id] = { killTime: now, respawnTime, lastKiller: interaction.user.username };
    save();
    log(interaction.user, `MISSED-WINDOW KILL ${boss.name} — kill: ${toServerDateTimeStr(now)} — respawn: ${toServerDateTimeStr(respawnTime)}`);
    spawnWarnings[id] = { warned5: false, warned20: false, windowCreated: false, missedHandled: false };
    lastWindowOrder = [];

    await announceKill(interaction.channel, interaction.user, `killed **${boss.name}** (missed-window kill)`,
      `🕒 Kill: ${toServerDateTimeStr(now)} — 🔄 Respawn: ${toServerDateTimeStr(respawnTime)}`);
    return interaction.deferUpdate();
  }

  // ── MISSED WINDOW — Set Time button ──────────────────────────────────────
  if (interaction.isButton() && interaction.customId.startsWith("missed_settime_")) {
    const id   = interaction.customId.replace("missed_settime_", "");
    const boss = BOSSES.find(b => b.id === id);
    log(interaction.user, `Opened set-time modal for ${boss.name} (missed window)`);
    const modal = new ModalBuilder()
      .setCustomId("missed_killtime_" + id)
      .setTitle(`Set Kill Time — ${boss.name}`);
    modal.addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId("time").setLabel("HH:MM (24h, server time)").setStyle(TextInputStyle.Short)
    ));
    return interaction.showModal(modal);
  }

  // ── MISSED WINDOW — modal submit ──────────────────────────────────────────
  if (interaction.isModalSubmit() && interaction.customId.startsWith("missed_killtime_")) {
    snapshot();
    const id          = interaction.customId.replace("missed_killtime_", "");
    const boss        = BOSSES.find(b => b.id === id);
    const [h, m]      = interaction.fields.getTextInputValue("time").split(":").map(Number);
    const kill        = parseServerTime(h, m);
    const respawnTime = kill.getTime() + 7 * 60 * 60 * 1000;

    if (missedWindowDashboards[id]) {
      missedWindowDashboards[id].msg && missedWindowDashboards[id].msg.delete().catch(() => {});
      delete missedWindowDashboards[id];
    }

    data.kills[id] = { killTime: kill.getTime(), respawnTime, lastKiller: interaction.user.username };
    save();
    log(interaction.user, `MANUAL SET (missed-window) ${boss.name} — kill: ${toServerDateTimeStr(kill.getTime())} — respawn: ${toServerDateTimeStr(respawnTime)}`);
    spawnWarnings[id] = { warned5: false, warned20: false, windowCreated: false, missedHandled: false };
    lastWindowOrder = [];

    await announceKill(interaction.channel, interaction.user, `manually set **${boss.name}** kill time (from missed-window)`,
      `🕒 Kill: ${toServerDateTimeStr(kill.getTime())} — 🔄 Respawn: ${toServerDateTimeStr(respawnTime)}`);
    return interaction.deferUpdate();
  }

  // ── INSERT TIME — boss select ─────────────────────────────────────────────
  if (interaction.isButton() && interaction.customId === "insert_time") {
    log(interaction.user, `Opened insert: boss selection menu`);
    const menu = new StringSelectMenuBuilder()
      .setCustomId("select_boss_insert").setPlaceholder("Select boss")
      .addOptions(BOSSES.map(b => ({ label: b.name, value: b.id })));
    return interaction.reply({
      content: "📝 Select boss — enter kill time in server time (HH:MM, 24h):",
      components: [new ActionRowBuilder().addComponents(menu)],
      flags: MessageFlags.Ephemeral
    });
  }

  // ── INSERT TIME — modal ───────────────────────────────────────────────────
  if (interaction.isStringSelectMenu() && interaction.customId === "select_boss_insert") {
    const id   = interaction.values[0];
    const boss = BOSSES.find(b => b.id === id);
    log(interaction.user, `Insert: selected ${boss.name}`);
    const modal = new ModalBuilder().setCustomId(`killtime_server_${id}`).setTitle(`Insert Kill Time — ${boss.name}`);
    modal.addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId("time").setLabel("HH:MM (24h, server time)").setStyle(TextInputStyle.Short).setPlaceholder("e.g. 21:34")
    ));
    return interaction.showModal(modal);
  }

  // ── INSERT TIME — submit ──────────────────────────────────────────────────
  if (interaction.isModalSubmit() && interaction.customId.startsWith("killtime_server_")) {
    snapshot();
    const id          = interaction.customId.replace("killtime_server_", "");
    const boss        = BOSSES.find(b => b.id === id);
    const [h, m]      = interaction.fields.getTextInputValue("time").split(":").map(Number);
    const kill        = parseServerTime(h, m);
    const respawnTime = kill.getTime() + 7 * 60 * 60 * 1000;

    data.kills[id] = { killTime: kill.getTime(), respawnTime, lastKiller: interaction.user.username };
    save();
    log(interaction.user, `MANUAL SET ${boss.name} — kill: ${toServerDateTimeStr(kill.getTime())} — respawn: ${toServerDateTimeStr(respawnTime)}`);
    spawnWarnings[id] = { warned5: false, warned20: false, windowCreated: false, missedHandled: false };
    if (missedWindowDashboards[id]) {
      missedWindowDashboards[id].msg && missedWindowDashboards[id].msg.delete().catch(() => {});
      delete missedWindowDashboards[id];
    }
    lastWindowOrder = [];

    await announceKill(interaction.channel, interaction.user, `manually set **${boss.name}** kill time`,
      `🕒 Kill: ${toServerDateTimeStr(kill.getTime())} — 🔄 Respawn: ${toServerDateTimeStr(respawnTime)}`);
    return interaction.deferUpdate();
  }

  // ── RESET — dropdown ─────────────────────────────────────────────────────
  if (interaction.isButton() && interaction.customId === "reset_all") {
    log(interaction.user, `Opened reset menu`);
    const menu = new StringSelectMenuBuilder()
      .setCustomId("reset_select").setPlaceholder("Select what to reset")
      .addOptions([
        ...BOSSES.map(b => ({ label: `Reset ${b.name}`, value: b.id })),
        { label: "☠️ DELETE ALL TIMERS (Server Reset)", value: "DELETE_ALL" }
      ]);
    return interaction.reply({
      content: "🧹 What do you want to reset?",
      components: [new ActionRowBuilder().addComponents(menu)],
      flags: MessageFlags.Ephemeral
    });
  }

  // ── RESET — apply ─────────────────────────────────────────────────────────
  if (interaction.isStringSelectMenu() && interaction.customId === "reset_select") {
    snapshot();
    const value = interaction.values[0];

    if (value === "DELETE_ALL") {
      for (const id of Object.keys(spawnWindowMessages)) {
        spawnWindowMessages[id].msg && spawnWindowMessages[id].msg.delete().catch(() => {});
        delete spawnWindowMessages[id];
      }
      for (const id in missedWindowDashboards) {
        missedWindowDashboards[id].msg && missedWindowDashboards[id].msg.delete().catch(() => {});
      }
      missedWindowDashboards = {};
      for (const key of Object.keys(everyoneWarnings)) await clearEveryoneWarning(key);
      data.kills = {};
      save();
      log(interaction.user, `RESET ALL TIMERS`);
      lastWindowOrder = [];
      await announceAdmin(interaction.channel, interaction.user, "reset **ALL** timers ☠️");
      return interaction.deferUpdate();
    }

    const boss = BOSSES.find(b => b.id === value);
    if (spawnWindowMessages[value]) {
      spawnWindowMessages[value].msg && spawnWindowMessages[value].msg.delete().catch(() => {});
      delete spawnWindowMessages[value];
    }
    if (missedWindowDashboards[value]) {
      missedWindowDashboards[value].msg && missedWindowDashboards[value].msg.delete().catch(() => {});
      delete missedWindowDashboards[value];
    }
    await clearEveryoneWarning(`${value}_5min`);
    await clearEveryoneWarning(`${value}_20min`);
    delete data.kills[value];
    spawnWarnings[value] = { warned5: false, warned20: false, windowCreated: false, missedHandled: false };
    save();
    log(interaction.user, `RESET timer for ${boss.name}`);
    lastWindowOrder = [];
    await announceAdmin(interaction.channel, interaction.user, `reset timer for **${boss.name}**`);
    return interaction.deferUpdate();
  }

  // ── UNDO ──────────────────────────────────────────────────────────────────
  if (interaction.isButton() && interaction.customId === "undo") {
    const ok = undo();
    log(interaction.user, ok ? `UNDO success` : `UNDO failed — nothing to undo`);
    await announceAdmin(interaction.channel, interaction.user, ok ? "used **Undo** ↩️" : "tried to undo — nothing to undo");
    return interaction.deferUpdate();
  }

  // ── LOGS ──────────────────────────────────────────────────────────────────
  if (interaction.isButton() && interaction.customId === "show_logs") {
    log(interaction.user, `Viewed logs`);
    return interaction.reply({ embeds: [buildLogEmbed()], flags: MessageFlags.Ephemeral });
  }
});

client.login(TOKEN);
