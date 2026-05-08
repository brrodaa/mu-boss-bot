// =====================
// GLOBAL CRASH HANDLERS
// =====================
process.on("uncaughtException", (err) => {
  console.error("[UncaughtException]", err.message, err.stack);
  // deliberately NOT calling process.exit() so Railway keeps the process alive
});

process.on("unhandledRejection", (err) => {
  if (err?.status === 503 || err?.status === 502) {
    console.warn("[Discord] Temporary API outage (503/502), ignoring");
    return;
  }
  console.error("[UnhandledRejection]", err?.message ?? err);
});

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
const TICK_RATE  = 5000;
const MAX_UNDO   = 10;

const EVERYONE_WARNING_LIFESPAN_MS    = 10 * 60 * 1000;
const EVERYONE_REPIN_BEFORE_EXPIRE_MS =  1 * 60 * 1000;

const WINDOW_GRACE_MS = 15 * 60 * 1000;

// =====================
// STATE
// =====================
let data = { kills: {} };
let dashboardMessage = null;

let spawnWarnings = {};
let spawnWindowMessages = {};
let missedWindowMessages = {};
let everyoneWarnings = {};

let adminLogs = [];
let undoStack = [];

const MAX_DISCORD_BACKUPS = 7;
let backupMessages  = [];
let backupSlotIndex = 0;
let logMessage      = null;

let lastStackFingerprint = "";
let repinInProgress = false;

// =====================
// BOSSES
// =====================
function buildBosses() {
  const bosses = [];
  for (let i = 1; i <= 3; i++) bosses.push({ id: `lorencia_${i}`, name: `Kharzul #${i}`,          type: "kharzul" });
  for (let i = 1; i <= 3; i++) bosses.push({ id: `davias_${i}`,   name: `Vescrya #${i}`,           type: "vescrya" });
  for (let i = 1; i <= 2; i++) bosses.push({ id: `crywolf_${i}`,  name: `Muggron #${i} Crywolf`,   type: "muggron" });
  for (let i = 1; i <= 2; i++) bosses.push({ id: `barracks_${i}`, name: `Muggron #${i} Barracks`,  type: "muggron" });
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
  {
    name: "🐇 Lunar Rabbit",
    times: ["05:25","11:25","17:25","23:25"],
    warnMinutes: 5,
  },
  {
    name: "🔥 Fire Flame",
    times: ["01:25","07:25","13:25","19:25"],
    warnMinutes: 5,
  },
  {
    name: "🎁 Pouch of Blessing",
    times: ["03:25","09:25","15:25","21:25"],
    warnMinutes: 5,
  },
];

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
  const now       = new Date();
  const dateStr   = now.toLocaleDateString("en-CA", { timeZone: SERVER_TZ });
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

function nextOccurrenceMs(hhmm, afterMs) {
  const [h, m]  = hhmm.split(":").map(Number);
  const afterDt = new Date(afterMs);

  for (let dayOffset = 0; dayOffset <= 1; dayOffset++) {
    const base    = new Date(afterDt);
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
  const localEmpty =
    !fs.existsSync("data.json") ||
    (() => {
      try {
        const d = JSON.parse(fs.readFileSync("data.json", "utf8"));
        return !d.kills || Object.values(d.kills).every(e => e.respawnTime < now - 2 * 60 * 60 * 1000);
      } catch { return true; }
    })();

  if (!localEmpty) {
    console.log("[Recovery] Local data.json exists and has timers — skipping Discord recovery.");
    return false;
  }

  console.log("[Recovery] Local data is absent/empty/stale — scanning Discord for latest backup...");
  try {
    const backupCh   = await client.channels.fetch(DATA_BACKUP_CHANNEL_ID);
    const fetched    = await backupCh.messages.fetch({ limit: 100 });
    const candidates = [...fetched.values()].filter(m =>
      m.author.id === client.user.id &&
      m.attachments.size > 0 &&
      [...m.attachments.values()].some(a => a.name && a.name.endsWith(".json"))
    );

    if (!candidates.length) { console.warn("[Recovery] No backup messages found."); return false; }

    const best       = candidates.sort((a, b) => b.editedTimestamp - a.editedTimestamp)[0];
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
// BACKUP — local files
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
// BACKUP — Discord persistent slots
// =====================
function buildBackupEmbed(slotNumber, takenAt) {
  const stamp = toServerDateTimeStr(takenAt || Date.now());
  const lines = BOSSES.map(b => {
    const e = data.kills[b.id];
    if (!e) return `• **${b.name}**: —`;
    return `• **${b.name}**: by ${e.lastKiller} — kill: ${toServerDateTimeStr(e.killTime)} — respawn: ${toServerDateTimeStr(e.respawnTime)}`;
  });
  return new EmbedBuilder()
    .setTitle(`💾 Backup Slot ${slotNumber} / ${MAX_DISCORD_BACKUPS}`)
    .setColor(0x2b2d31)
    .setDescription(lines.join("\n"))
    .setFooter({ text: `Last updated: ${stamp} (server time)` });
}

async function initBackupMessages(backupChannel) {
  backupMessages  = [];
  backupSlotIndex = 0;

  try {
    const existing  = await backupChannel.messages.fetch({ limit: 50 });
    const botSlots  = [...existing.values()]
      .filter(m =>
        m.author.id === client.user.id &&
        m.embeds.length > 0 &&
        m.embeds[0]?.title?.startsWith("💾 Backup Slot")
      )
      .sort((a, b) => a.createdTimestamp - b.createdTimestamp);

    if (botSlots.length === MAX_DISCORD_BACKUPS) {
      backupMessages  = botSlots;
      backupSlotIndex = 0;
      console.log(`[Backup] Reusing ${MAX_DISCORD_BACKUPS} existing backup slot messages — no data overwrite.`);
      return;
    }
    console.log(`[Backup] Found ${botSlots.length}/${MAX_DISCORD_BACKUPS} existing slots — posting fresh set.`);
  } catch (err) {
    console.warn("[Backup] Could not fetch existing backup messages — posting fresh set.", err);
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
  console.log(`[Backup] ${MAX_DISCORD_BACKUPS} fresh backup slots posted.`);
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
  } catch (err) {
    // Don't let backup errors propagate — just log what matters
    if (err.status === 503 || err.status === 502) {
      console.warn(`[Backup] Slot ${slotNumber} — Discord temporarily unavailable (${err.status}), will retry next cycle`);
    } else {
      console.error(`[Backup] Slot ${slotNumber} edit failed: ${err.status} ${err.message}`);
    }
  }
  backupSlotIndex = (backupSlotIndex + 1) % MAX_DISCORD_BACKUPS;
}

async function runBackup() {
  try { console.log(`[Backup] ${saveLocalBackup()}`); await updateDiscordBackupSlot(); }
  catch (err) { console.error("[Backup]", err.message ?? err); }
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
  const recent      = adminLogs.slice(0, 20);
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
  catch (err) { console.error("[Log] Update failed:", err.message ?? err); }
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
  } catch (err) { console.error("[Log Channel]", err.message ?? err); }
}

// =====================
// @EVERYONE WARNINGS
// =====================
async function postEveryoneWarning(channel, key, content) {
  await clearEveryoneWarning(key);

  let msg;
  try { msg = await channel.send({ content }); }
  catch (err) { console.error("[Warning] Failed to post @everyone:", err.message ?? err); return; }

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
function buildSpawnWindowEmbed(boss, windowStart, windowEnd) {
  const remaining = windowEnd - Date.now();
  const tsStart   = Math.floor(windowStart / 1000);
  const tsEnd     = Math.floor(windowEnd / 1000);
  const desc = remaining > 0
    ? `⏳ Time left: **${format(remaining)}**\n🟢 Opened: ${toServerTimeStr(windowStart)} (server) — <t:${tsStart}:t> (your time)\n🔴 Closes: ${toServerTimeStr(windowEnd)} (server) — <t:${tsEnd}:t> (your time)`
    : `⌛ Window has closed — log the kill or wait for next respawn\n🟢 Opened: ${toServerTimeStr(windowStart)} (server) — <t:${tsStart}:t> (your time)\n🔴 Closed: ${toServerTimeStr(windowEnd)} (server) — <t:${tsEnd}:t> (your time)`;
  return new EmbedBuilder()
    .setTitle(`🟢 ${boss.name} — Spawn window active`)
    .setColor(0x00cc66)
    .setDescription(desc);
}

function buildSpawnWindowComponents(id) {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("window_kill_"    + id).setLabel("💀 Killed").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("window_settime_" + id).setLabel("⏱️ Set Time").setStyle(ButtonStyle.Secondary)
  )];
}

// =====================
// MISSED WINDOW EMBEDS & COMPONENTS
// =====================
function buildMissedWindowEmbed(boss, windowStart, windowEnd) {
  const now        = Date.now();
  const untilStart = windowStart - now;
  const untilEnd   = windowEnd   - now;

  let statusLine;
  if (untilStart > 0) {
    const tsOpen = Math.floor(windowStart / 1000);
    statusLine = `⏳ Next possible window in: **${format(untilStart)}**\n🕒 Opens at: ${toServerTimeStr(windowStart)} (server) — <t:${tsOpen}:t> (your time)`;
  } else if (untilEnd > 0) {
    const tsClose = Math.floor(windowEnd / 1000);
    statusLine = `🟡 **WINDOW OPEN** — closes in: **${format(untilEnd)}**\n🕒 Closes: ${toServerTimeStr(windowEnd)} (server) — <t:${tsClose}:t> (your time)`;
  } else {
    statusLine = `⚠️ Window has closed with no kill recorded.`;
  }

  return new EmbedBuilder()
    .setTitle(`⚠️ ${boss.name} — Spawn window active with possible wrong timer`)
    .setColor(0xff6600)
    .setDescription(
      `${statusLine}\n\n` +
      `> ⚠️ **This timer might be incorrect and/or it will take longer for respawn.**\n` +
      `> The previous window passed without a kill being logged.`
    )
    .setFooter({ text: `Auto-updating | Window: ${toServerTimeStr(windowStart)} – ${toServerTimeStr(windowEnd)} (server)` });
}

function buildMissedWindowComponents(id) {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("missed_kill_"    + id).setLabel("💀 Killed").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("missed_settime_" + id).setLabel("⏱️ Set Time").setStyle(ButtonStyle.Secondary)
  )];
}

// =====================
// STACK FINGERPRINT
// =====================
function computeStackFingerprint() {
  const now = Date.now();

  const missed = Object.entries(missedWindowMessages)
    .filter(([, w]) => w.nextWindowStart <= now && w.nextWindowEnd + WINDOW_GRACE_MS > now)
    .sort(([, a], [, b]) => a.nextWindowEnd - b.nextWindowEnd)
    .map(([id]) => id);

  const spawn = Object.entries(spawnWindowMessages)
    .filter(([, w]) => w.windowEnd + WINDOW_GRACE_MS > now)
    .sort(([, a], [, b]) => a.windowEnd - b.windowEnd)
    .map(([id]) => id);

  return `missed:${missed.join(",")}|spawn:${spawn.join(",")}`;
}

// =====================
// ATOMIC FULL REPIN
// =====================
async function fullRepin(channel) {
  if (repinInProgress) return;
  repinInProgress = true;

  try {
    const now = Date.now();

    if (dashboardMessage) {
      await dashboardMessage.delete().catch(() => {});
      dashboardMessage = null;
    }

    for (const id of Object.keys(missedWindowMessages)) {
      const w = missedWindowMessages[id];
      clearTimeout(w.deleteTimer);
      if (w.msg) w.msg.delete().catch(() => {});
      w.msg = null; w.deleteTimer = null;
    }

    for (const id of Object.keys(spawnWindowMessages)) {
      const w = spawnWindowMessages[id];
      clearTimeout(w.deleteTimer);
      if (w.msg) w.msg.delete().catch(() => {});
      w.msg = null; w.deleteTimer = null;
    }

    for (const id of Object.keys(missedWindowMessages)) {
      if (missedWindowMessages[id].nextWindowEnd + WINDOW_GRACE_MS <= now)
        delete missedWindowMessages[id];
    }
    for (const id of Object.keys(spawnWindowMessages)) {
      if (spawnWindowMessages[id].windowEnd + WINDOW_GRACE_MS <= now)
        delete spawnWindowMessages[id];
    }

    dashboardMessage = await channel.send({
      embeds:     [buildEmbed()],
      components: buildButtons(),
      flags:      MessageFlags.SuppressNotifications
    });

    const missedEntries = Object.entries(missedWindowMessages)
      .filter(([, w]) => w.nextWindowStart <= now)
      .sort(([, a], [, b]) => a.nextWindowEnd - b.nextWindowEnd);

    for (const [id, w] of missedEntries) {
      try {
        const msg = await channel.send({
          embeds:     [buildMissedWindowEmbed(w.boss, w.nextWindowStart, w.nextWindowEnd)],
          components: buildMissedWindowComponents(id),
          flags:      MessageFlags.SuppressNotifications
        });
        w.msg = msg;
        const ttl = (w.nextWindowEnd - now) + WINDOW_GRACE_MS;
        w.deleteTimer = setTimeout(() => {
          msg.delete().catch(() => {});
          delete missedWindowMessages[id];
          lastStackFingerprint = "";
        }, Math.max(ttl, 0));
      } catch (err) {
        console.error(`[Repin] Failed to post missed window for ${id}:`, err.message ?? err);
        delete missedWindowMessages[id];
      }
    }

    const spawnEntries = Object.entries(spawnWindowMessages)
      .sort(([, a], [, b]) => a.windowEnd - b.windowEnd);

    for (const [id, w] of spawnEntries) {
      try {
        const msg = await channel.send({
          embeds:     [buildSpawnWindowEmbed(w.boss, w.windowStart, w.windowEnd)],
          components: buildSpawnWindowComponents(id),
          flags:      MessageFlags.SuppressNotifications
        });
        w.msg = msg;
        const ttl = (w.windowEnd - now) + WINDOW_GRACE_MS;
        w.deleteTimer = setTimeout(() => {
          msg.delete().catch(() => {});
          delete spawnWindowMessages[id];
          lastStackFingerprint = "";
        }, Math.max(ttl, 0));
      } catch (err) {
        console.error(`[Repin] Failed to post spawn window for ${id}:`, err.message ?? err);
        delete spawnWindowMessages[id];
      }
    }

    lastStackFingerprint = computeStackFingerprint();
    console.log(`[Repin] Stack: dashboard -> missed:[${Object.keys(missedWindowMessages).filter(id => missedWindowMessages[id].nextWindowStart <= now).join(",")}] -> spawn:[${Object.keys(spawnWindowMessages).join(",")}]`);

  } catch (err) {
    console.error("[Repin] Error:", err.message ?? err);
  } finally {
    repinInProgress = false;
  }
}

// =====================
// SPAWN WINDOW CREATION
// =====================
async function createSpawnWindow(boss, id, channel, windowEnd) {
  if (spawnWindowMessages[id]) return;
  const windowStart = windowEnd - 60 * 60 * 1000;
  spawnWindowMessages[id] = { msg: null, windowStart, windowEnd, boss, deleteTimer: null };
  lastStackFingerprint = "";
}

// =====================
// MISSED WINDOW / AUTO-ADVANCE
// =====================
async function handleMissedWindow(boss, id, channel) {
  const e = data.kills[id];
  if (!e) return;

  console.log(`[MissedWindow] No kill recorded for ${boss.name} — auto-advancing by 7h`);

  snapshot();
  e.respawnTime = e.respawnTime + 7 * 60 * 60 * 1000;
  e.killTime    = e.respawnTime - 7 * 60 * 60 * 1000;
  save();

  spawnWarnings[id] = { warned5: false, warned20: false, windowCreated: false, missedHandled: false };

  clearBossCards(id);

  const nextWindowStart = e.respawnTime;
  const nextWindowEnd   = e.respawnTime + 2 * 60 * 60 * 1000;

  missedWindowMessages[id] = {
    msg:            null,
    deleteTimer:    null,
    nextWindowStart,
    nextWindowEnd,
    pingedStart:    false,
    pinged1h:       false,
    pinged20min:    false,
    boss,
  };
}

async function tickMissedWindowMessages(channel) {
  const now = Date.now();

  for (const id of Object.keys(missedWindowMessages)) {
    const w = missedWindowMessages[id];

    if (w.nextWindowStart <= now && !w.msg) {
      lastStackFingerprint = "";
    }

    if (!w.msg) continue;

    w.msg.edit({
      embeds:     [buildMissedWindowEmbed(w.boss, w.nextWindowStart, w.nextWindowEnd)],
      components: buildMissedWindowComponents(id)
    }).catch(() => {});

    const untilStart = w.nextWindowStart - now;
    const untilEnd   = w.nextWindowEnd   - now;

    if (!w.pingedStart && untilStart <= 0 && untilEnd > 0) {
      w.pingedStart = true;
      const tsClose = Math.floor(w.nextWindowEnd / 1000);
      const content =
        `@everyone 🔶 **${w.boss.name}** missed window is now open! ` +
        `Window closes in **${format(untilEnd)}** — ${toServerTimeStr(w.nextWindowEnd)} (server) — <t:${tsClose}:t> (your time)\n` +
        `⚠️ Timer might be incorrect — boss may take longer to respawn.`;
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
// =====================
async function checkFixedEvents(channel) {
  const now = Date.now();

  for (const ev of FIXED_EVENTS) {
    for (const hhmm of ev.times) {
      const eventMs   = nextOccurrenceMs(hhmm, now);
      const warnMs    = ev.warnMinutes * 60 * 1000;
      const timeUntil = eventMs - now;

      if (timeUntil > warnMs + TICK_RATE || timeUntil < -TICK_RATE) continue;

      const eventDate = new Date(eventMs).toLocaleDateString("en-CA", { timeZone: SERVER_TZ });
      const key       = `${ev.name}|${hhmm}|${eventDate}`;
      if (eventPingedKeys.has(key)) continue;
      eventPingedKeys.add(key);

      const eventTimeStr = toServerTimeStr(eventMs);
      const tsEvent      = Math.floor(eventMs / 1000);
      let msg =
        `@everyone ⏰ **${ev.name}** starts in **${ev.warnMinutes} minutes**!\n` +
        `🕒 ${eventTimeStr} (server time) — <t:${tsEvent}:t> (your local time)`;
      if (ev.extraNote) msg += `\n${ev.extraNote}`;

      channel.send(msg);
      forwardToLogChannel(msg);

      if (eventPingedKeys.size > 500) {
        const yesterday = new Date(now - 25 * 60 * 60 * 1000)
          .toLocaleDateString("en-CA", { timeZone: SERVER_TZ });
        for (const k of eventPingedKeys) {
          if (k.endsWith(`|${yesterday}`)) eventPingedKeys.delete(k);
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

    if (cooldown > 0) {
      const tsRespawn = Math.floor(e.respawnTime / 1000);
      text = `🔴 ${format(cooldown)}\n🕒 ${toServerTimeStr(e.respawnTime)} (server) — <t:${tsRespawn}:t> (your time)\n👤 ${e.lastKiller}`;
    } else if (windowLeft > 0) {
      const tsRespawn = Math.floor(e.respawnTime / 1000);
      text = `🟢 WINDOW — ⏳ ${format(windowLeft)}\n🕒 Was due: ${toServerTimeStr(e.respawnTime)} (server) — <t:${tsRespawn}:t> (your time)\n👤 ${e.lastKiller}`;
    } else {
      const nextWindowOpen  = e.respawnTime + 60 * 60 * 1000;
      const nextWindowClose = e.respawnTime + 2 * 60 * 60 * 1000;
      const tsOpen  = Math.floor(nextWindowOpen  / 1000);
      const tsClose = Math.floor(nextWindowClose / 1000);
      const nextLine = nextWindowClose > now
        ? `🔄 Next possible: <t:${tsOpen}:t> — <t:${tsClose}:t> (your time)`
        : `🔄 Next window also passed — update manually`;
      text = `⚠️ Timer possibly wrong\n🕒 Last known respawn: ${toServerTimeStr(e.respawnTime)} (server)\n${nextLine}\n👤 ${e.lastKiller}`;
      isBroken = true;
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
// MAIN LOOP — wrapped in try/catch so one bad tick never kills the interval
// =====================
function startLoop() {
  setInterval(async () => {
    try {
      if (!dashboardMessage) return;
      const channel = dashboardMessage.channel;

      // STEP 1: Fingerprint check
      await tickMissedWindowMessages(channel);

      const currentFingerprint = computeStackFingerprint();
      if (currentFingerprint !== lastStackFingerprint) {
        await fullRepin(channel);
      }

      // STEP 2: Fast path — all edits fired concurrently
      await Promise.all([
        dashboardMessage.edit({ embeds: [buildEmbed()], components: buildButtons() })
          .catch(err => {
            if (err.code === 10008) { dashboardMessage = null; lastStackFingerprint = ""; }
            else if (err.status !== 503 && err.status !== 502) {
              console.error("[Loop] Dashboard edit failed:", err.message ?? err);
            }
          }),

        ...Object.entries(missedWindowMessages)
          .filter(([, w]) => w.msg)
          .map(([id, w]) =>
            w.msg.edit({
              embeds:     [buildMissedWindowEmbed(w.boss, w.nextWindowStart, w.nextWindowEnd)],
              components: buildMissedWindowComponents(id)
            }).catch(err => {
              if (err.code === 10008) { delete missedWindowMessages[id]; lastStackFingerprint = ""; }
            })
          ),

        ...Object.entries(spawnWindowMessages)
          .filter(([, w]) => w.msg)
          .map(([id, w]) =>
            w.msg.edit({
              embeds:     [buildSpawnWindowEmbed(w.boss, w.windowStart, w.windowEnd)],
              components: buildSpawnWindowComponents(id)
            }).catch(err => {
              if (err.code === 10008) { delete spawnWindowMessages[id]; lastStackFingerprint = ""; }
            })
          )
      ]);

      // STEP 3: Warnings & event checks
      checkWarnings(channel);
      await checkFixedEvents(channel);

    } catch (err) {
      // Log the error but let the interval keep running on the next tick
      console.error("[Loop] Tick error (recovered):", err.message ?? err);
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

    if (cooldown > 0 && cooldown <= 5 * 60 * 1000 && !w.warned5) {
      w.warned5 = true;
      if (!missedWindowMessages[b.id]) {
        postEveryoneWarning(channel, `${b.id}_5min`, `@everyone ⏳ **${b.name}** spawns in 5 minutes`);
      }
    }

    if (cooldown <= 0 && windowLeft > 2 * 60 * 1000 && windowLeft <= 20 * 60 * 1000 && !w.warned20) {
      w.warned20 = true;
      postEveryoneWarning(channel, `${b.id}_20min`, `@everyone ⚠️ **${b.name}** may spawn in 20 minutes`);
    }

    if (cooldown <= 0 && windowLeft > 0 && !w.windowCreated) {
      w.windowCreated = true;
      if (!missedWindowMessages[b.id]) {
        createSpawnWindow(b, b.id, channel, windowEnd);
      }
    }

    if (
      TRACKED_BOSS_TYPES.has(b.type) &&
      timeSinceWindowExpired >= 10 * 60 * 1000 &&
      !w.missedHandled
    ) {
      w.missedHandled = true;
      handleMissedWindow(b, b.id, channel);
    }
  }
}

// =====================
// CLEANUP HELPER
// =====================
function clearBossCards(id) {
  if (spawnWindowMessages[id]) {
    clearTimeout(spawnWindowMessages[id].deleteTimer);
    if (spawnWindowMessages[id].msg) spawnWindowMessages[id].msg.delete().catch(() => {});
    delete spawnWindowMessages[id];
  }
  if (missedWindowMessages[id]) {
    clearTimeout(missedWindowMessages[id].deleteTimer);
    if (missedWindowMessages[id].msg) missedWindowMessages[id].msg.delete().catch(() => {});
    delete missedWindowMessages[id];
  }
  clearEveryoneWarning(`${id}_5min`);
  clearEveryoneWarning(`${id}_20min`);
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
    catch (err) { console.error("[Backup] Could not fetch DATA_BACKUP_CHANNEL_ID, falling back to main channel:", err.message ?? err); await initBackupMessages(channel); }
  } else {
    await initBackupMessages(channel);
  }

  dashboardMessage = await channel.send({
    embeds: [buildEmbed()],
    components: buildButtons(),
    flags: MessageFlags.SuppressNotifications
  });
  lastStackFingerprint = computeStackFingerprint();

  startLoop();
  startBackupLoop();

  setTimeout(() => runBackup().catch(err => console.error("[Backup] Startup backup failed:", err.message ?? err)), 5000);
});

// =====================
// INTERACTIONS
// =====================
client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isButton() && !interaction.isStringSelectMenu() && !interaction.isModalSubmit()) return;

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
    clearBossCards(id);

    await announceKill(interaction.channel, interaction.user, `killed **${boss.name}**`,
      `🕒 Kill: ${toServerDateTimeStr(now)} — 🔄 Respawn: ${toServerDateTimeStr(respawnTime)}`);
    return interaction.deferUpdate();
  }

  if (interaction.isButton() && interaction.customId.startsWith("window_kill_")) {
    snapshot();
    const id          = interaction.customId.replace("window_kill_", "");
    const boss        = BOSSES.find(b => b.id === id);
    const now         = Date.now();
    const respawnTime = now + 7 * 60 * 60 * 1000;

    clearBossCards(id);

    data.kills[id] = { killTime: now, respawnTime, lastKiller: interaction.user.username };
    save();
    log(interaction.user, `WINDOW KILL ${boss.name} — kill: ${toServerDateTimeStr(now)} — respawn: ${toServerDateTimeStr(respawnTime)}`);
    spawnWarnings[id] = { warned5: false, warned20: false, windowCreated: false, missedHandled: false };

    await announceKill(interaction.channel, interaction.user, `killed **${boss.name}** (window kill)`,
      `🕒 Kill: ${toServerDateTimeStr(now)} — 🔄 Respawn: ${toServerDateTimeStr(respawnTime)}`);
    return interaction.deferUpdate();
  }

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

  if (interaction.isModalSubmit() && interaction.customId.startsWith("window_killtime_")) {
    snapshot();
    const id          = interaction.customId.replace("window_killtime_", "");
    const boss        = BOSSES.find(b => b.id === id);
    const [h, m]      = interaction.fields.getTextInputValue("time").split(":").map(Number);
    const kill        = parseServerTime(h, m);
    const respawnTime = kill.getTime() + 7 * 60 * 60 * 1000;

    clearBossCards(id);

    data.kills[id] = { killTime: kill.getTime(), respawnTime, lastKiller: interaction.user.username };
    save();
    log(interaction.user, `MANUAL SET (window) ${boss.name} — kill: ${toServerDateTimeStr(kill.getTime())} — respawn: ${toServerDateTimeStr(respawnTime)}`);
    spawnWarnings[id] = { warned5: false, warned20: false, windowCreated: false, missedHandled: false };

    await announceKill(interaction.channel, interaction.user, `manually set **${boss.name}** kill time (from window)`,
      `🕒 Kill: ${toServerDateTimeStr(kill.getTime())} — 🔄 Respawn: ${toServerDateTimeStr(respawnTime)}`);
    return interaction.deferUpdate();
  }

  if (interaction.isButton() && interaction.customId.startsWith("missed_kill_")) {
    snapshot();
    const id          = interaction.customId.replace("missed_kill_", "");
    const boss        = BOSSES.find(b => b.id === id);
    const now         = Date.now();
    const respawnTime = now + 7 * 60 * 60 * 1000;

    clearBossCards(id);

    data.kills[id] = { killTime: now, respawnTime, lastKiller: interaction.user.username };
    save();
    log(interaction.user, `MISSED-WINDOW KILL ${boss.name} — kill: ${toServerDateTimeStr(now)} — respawn: ${toServerDateTimeStr(respawnTime)}`);
    spawnWarnings[id] = { warned5: false, warned20: false, windowCreated: false, missedHandled: false };

    await announceKill(interaction.channel, interaction.user, `killed **${boss.name}** (missed-window kill)`,
      `🕒 Kill: ${toServerDateTimeStr(now)} — 🔄 Respawn: ${toServerDateTimeStr(respawnTime)}`);
    return interaction.deferUpdate();
  }

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

  if (interaction.isModalSubmit() && interaction.customId.startsWith("missed_killtime_")) {
    snapshot();
    const id          = interaction.customId.replace("missed_killtime_", "");
    const boss        = BOSSES.find(b => b.id === id);
    const [h, m]      = interaction.fields.getTextInputValue("time").split(":").map(Number);
    const kill        = parseServerTime(h, m);
    const respawnTime = kill.getTime() + 7 * 60 * 60 * 1000;

    clearBossCards(id);

    data.kills[id] = { killTime: kill.getTime(), respawnTime, lastKiller: interaction.user.username };
    save();
    log(interaction.user, `MANUAL SET (missed-window) ${boss.name} — kill: ${toServerDateTimeStr(kill.getTime())} — respawn: ${toServerDateTimeStr(respawnTime)}`);
    spawnWarnings[id] = { warned5: false, warned20: false, windowCreated: false, missedHandled: false };

    await announceKill(interaction.channel, interaction.user, `manually set **${boss.name}** kill time (from missed-window)`,
      `🕒 Kill: ${toServerDateTimeStr(kill.getTime())} — 🔄 Respawn: ${toServerDateTimeStr(respawnTime)}`);
    return interaction.deferUpdate();
  }

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
    clearBossCards(id);

    await announceKill(interaction.channel, interaction.user, `manually set **${boss.name}** kill time`,
      `🕒 Kill: ${toServerDateTimeStr(kill.getTime())} — 🔄 Respawn: ${toServerDateTimeStr(respawnTime)}`);
    return interaction.deferUpdate();
  }

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

  if (interaction.isStringSelectMenu() && interaction.customId === "reset_select") {
    snapshot();
    const value = interaction.values[0];

    if (value === "DELETE_ALL") {
      for (const id of Object.keys(spawnWindowMessages)) {
        clearTimeout(spawnWindowMessages[id].deleteTimer);
        if (spawnWindowMessages[id].msg) spawnWindowMessages[id].msg.delete().catch(() => {});
        delete spawnWindowMessages[id];
      }
      for (const id of Object.keys(missedWindowMessages)) {
        clearTimeout(missedWindowMessages[id].deleteTimer);
        if (missedWindowMessages[id].msg) missedWindowMessages[id].msg.delete().catch(() => {});
        delete missedWindowMessages[id];
      }
      for (const key of Object.keys(everyoneWarnings)) await clearEveryoneWarning(key);
      data.kills = {};
      save();
      log(interaction.user, `RESET ALL TIMERS`);
      await announceAdmin(interaction.channel, interaction.user, "reset **ALL** timers ☠️");
      return interaction.deferUpdate();
    }

    const boss = BOSSES.find(b => b.id === value);
    clearBossCards(value);
    delete data.kills[value];
    spawnWarnings[value] = { warned5: false, warned20: false, windowCreated: false, missedHandled: false };
    save();
    log(interaction.user, `RESET timer for ${boss.name}`);
    await announceAdmin(interaction.channel, interaction.user, `reset timer for **${boss.name}**`);
    return interaction.deferUpdate();
  }

  if (interaction.isButton() && interaction.customId === "undo") {
    if (undo()) {
      log(interaction.user, `UNDO`);
      for (const id of Object.keys(spawnWarnings))
        spawnWarnings[id] = { warned5: false, warned20: false, windowCreated: false, missedHandled: false };
      await announceAdmin(interaction.channel, interaction.user, "used **undo**");
    }
    return interaction.deferUpdate();
  }

  if (interaction.isButton() && interaction.customId === "show_logs") {
    return interaction.reply({
      embeds: [buildLogEmbed()],
      flags: MessageFlags.Ephemeral
    });
  }
});

client.login(TOKEN);
