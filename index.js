// =====================
// GLOBAL CRASH HANDLERS
// =====================
process.on("uncaughtException", (err) => {
  console.error("[UncaughtException]", err.message, err.stack);
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

const TOKEN          = process.env.BOT_TOKEN;
const CHANNEL_ID     = "1502646350410416128";
const LOG_CHANNEL_ID = "1502646498670674080";

if (!TOKEN) {
  console.error("ERROR: Missing BOT_TOKEN environment variable.");
  process.exit(1);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages]
});

// =====================
// SETTINGS
// =====================
const TICK_RATE  = 15000; // 15 seconds — reduced from 5s to ease API pressure

const MAX_UNDO   = 10;

const EVERYONE_WARNING_LIFESPAN_MS    = 10 * 60 * 1000;
const EVERYONE_REPIN_BEFORE_EXPIRE_MS =  1 * 60 * 1000;

const WINDOW_GRACE_MS = 15 * 60 * 1000;

// =====================
// STATE
// =====================
let data = { kills: {} };
let dashboardMessage = null;

let spawnWarnings        = {};
let spawnWindowMessages  = {};
let missedWindowMessages = {};
let everyoneWarnings     = {};

let adminLogs = [];
let undoStack = [];

let backupMessage   = null;
let logMessage      = null;

// ── Repin lock — prevents concurrent repins from stomping each other ──
let repinInProgress = false;

// ── Backup repost throttle — prevents interaction spam from causing message chaos ──
let lastBackupRepost = 0;
const BACKUP_REPOST_COOLDOWN_MS = 60 * 1000;

const BOT_START_TIME   = Date.now();
const STARTUP_GRACE_MS = 30 * 1000;

// =====================
// BOSSES
// =====================
function buildBosses() {
  const bosses = [];
  for (let i = 1; i <= 3; i++) bosses.push({ id: `lorencia_${i}`, name: `Kharzul #${i}`,         type: "kharzul" });
  for (let i = 1; i <= 3; i++) bosses.push({ id: `davias_${i}`,   name: `Vescrya #${i}`,          type: "vescrya" });
  for (let i = 1; i <= 2; i++) bosses.push({ id: `crywolf_${i}`,  name: `Muggron #${i} Crywolf`,  type: "muggron" });
  for (let i = 1; i <= 2; i++) bosses.push({ id: `barracks_${i}`, name: `Muggron #${i} Barracks`, type: "muggron" });
  return bosses;
}
const BOSSES = buildBosses();

const TRACKED_BOSS_TYPES = new Set(["kharzul", "vescrya"]);

// =====================
// FIXED EVENTS
// =====================
const FIXED_EVENTS = [
  { name: "🟡 Golden Invasion",   times: ["00:36","04:36","08:36","12:36","16:36","20:36"], warnMinutes: 5 },
  { name: "🧙 White Wizard",      times: ["09:45","12:45","15:45","18:45"],                 warnMinutes: 5 },
  { name: "💀 Death King",        times: ["21:45","00:45","03:45","06:45"],                 warnMinutes: 5 },
  { name: "⚡ Zaikan",            times: ["00:55","06:55","12:55","18:55"],                 warnMinutes: 5 },
  { name: "🐉 Red Dragon",        times: ["08:00","20:00"],                                 warnMinutes: 5 },
  { name: "🎅 Cursed Santa",      times: ["02:35","08:35","14:35","20:35"],                 warnMinutes: 5 },
  { name: "🏰 Chaos Castle",      times: ["13:55","17:55","21:55","01:55","05:55","09:55"], warnMinutes: 5 },
  {
    name: "⚔️ Battle Royale",
    times: ["02:00","08:00","14:00","20:00","23:00"],
    warnMinutes: 10,
    extraNote: "⚠️ Registration opens **5 minutes before** the event starts — be ready!",
  },
  { name: "🐇 Lunar Rabbit",      times: ["05:25","11:25","17:25","23:25"], warnMinutes: 5 },
  { name: "🔥 Fire Flame",        times: ["01:25","07:25","13:25","19:25"], warnMinutes: 5 },
  { name: "🎁 Pouch of Blessing", times: ["03:25","09:25","15:25","21:25"], warnMinutes: 5 },
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
    const base      = new Date(afterDt);
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
    const backupCh   = await client.channels.fetch(LOG_CHANNEL_ID);
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
// BACKUP — Discord single message
// =====================
function buildBackupEmbed(takenAt) {
  const stamp = toServerDateTimeStr(takenAt || Date.now());
  const lines = BOSSES.map(b => {
    const e = data.kills[b.id];
    if (!e) return `• **${b.name}**: —`;
    return `• **${b.name}**: by ${e.lastKiller} — kill: ${toServerDateTimeStr(e.killTime)} — respawn: ${toServerDateTimeStr(e.respawnTime)}`;
  });
  return new EmbedBuilder()
    .setTitle("💾 Timer Backup")
    .setColor(0x2b2d31)
    .setDescription(lines.join("\n"))
    .setFooter({ text: `Last updated: ${stamp} (server time)` });
}

function buildBackupFile() {
  const isoStamp = new Date().toISOString().replace(/:/g, "-").slice(0, 16);
  return { attachment: Buffer.from(JSON.stringify(data, null, 2), "utf8"), name: `backup-${isoStamp}.json` };
}

async function initBackupMessage(backupChannel) {
  try {
    const existing = await backupChannel.messages.fetch({ limit: 50 });
    const found = [...existing.values()].find(m =>
      m.author.id === client.user.id &&
      m.embeds.length > 0 &&
      m.embeds[0]?.title === "💾 Timer Backup"
    );
    if (found) {
      backupMessage = found;
      console.log("[Backup] Reusing existing backup message.");
      return;
    }
  } catch (err) {
    console.warn("[Backup] Could not scan for existing backup message:", err.message ?? err);
  }

  backupMessage = await backupChannel.send({
    embeds: [buildBackupEmbed(null)],
    files:  [buildBackupFile()],
    flags:  MessageFlags.SuppressNotifications
  });
  console.log("[Backup] Fresh backup message posted.");
}

async function updateDiscordBackup() {
  if (!backupMessage) return;
  try {
    await backupMessage.edit({
      embeds: [buildBackupEmbed(Date.now())],
      files:  [buildBackupFile()]
    });
    console.log("[Backup] Message updated.");
  } catch (err) {
    if (err.status === 503 || err.status === 502) {
      console.warn(`[Backup] Discord temporarily unavailable (${err.status}), will retry next cycle`);
    } else {
      console.error(`[Backup] Edit failed: ${err.status} ${err.message}`);
      backupMessage = null;
    }
  }
}

async function repostBackupToBottom() {
  try {
    const logCh = await client.channels.fetch(LOG_CHANNEL_ID);
    if (backupMessage) backupMessage.delete().catch(() => {});
    backupMessage = await logCh.send({
      embeds: [buildBackupEmbed(Date.now())],
      files:  [buildBackupFile()],
      flags:  MessageFlags.SuppressNotifications
    });
    console.log("[Backup] Reposted to bottom of log channel.");
  } catch (err) {
    console.error("[Backup] Repost failed:", err.message ?? err);
  }
}

async function runBackup() {
  try {
    console.log(`[Backup] ${saveLocalBackup()}`);
    await updateDiscordBackup();
  } catch (err) { console.error("[Backup]", err.message ?? err); }
}

function startBackupLoop() {
  const now = new Date();
  const msUntilNextHour = BACKUP_INTERVAL_MS -
    (now.getMinutes() * 60000 + now.getSeconds() * 1000 + now.getMilliseconds());

  console.log(`[Backup] First hourly update in ${Math.round(msUntilNextHour / 60000)}m.`);

  setTimeout(() => {
    runBackup();
    setInterval(runBackup, BACKUP_INTERVAL_MS);
  }, msUntilNextHour);
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

// Format with seconds — used for spawn window countdown (refreshes every tick)
function formatSeconds(ms) {
  if (ms <= 0) return "NOW";
  const totalSec = Math.floor(ms / 1000);
  const s = totalSec % 60;
  const m = Math.floor(totalSec / 60) % 60;
  const h = Math.floor(totalSec / 3600);
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
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
function stripPings(content) {
  return content.replace(/@everyone/g, "everyone").replace(/@here/g, "here");
}

async function forwardToLogChannel(content) {
  if (LOG_CHANNEL_ID === CHANNEL_ID) return;
  try {
    const logCh = await client.channels.fetch(LOG_CHANNEL_ID);
    await logCh.send({ content, flags: MessageFlags.SuppressNotifications });
  } catch (err) { console.error("[Log Channel]", err.message ?? err); }
}

async function announceKill(channel, user, action, extra = "") {
  const content = `⚔️ **${user.username}** ${action} — ${toServerDateTimeStr(Date.now())} (server time)${extra ? `\n${extra}` : ""}`;
  const msg = await channel.send({ content, flags: MessageFlags.SuppressNotifications });
  setTimeout(() => {
    msg.delete().catch(() => {});
    forwardToLogChannel(stripPings(content));
  }, 5 * 60 * 1000);
}

async function announceAdmin(channel, user, action) {
  const content = `📢 **${user.username}** ${action} — ${toServerDateTimeStr(Date.now())} (server time)`;
  const msg     = await channel.send({ content, flags: MessageFlags.SuppressNotifications });
  setTimeout(() => {
    msg.delete().catch(() => {});
    forwardToLogChannel(stripPings(content));
  }, 5 * 60 * 1000);
}

// =====================
// @EVERYONE WARNINGS
// =====================
async function postEveryoneWarning(channel, key, content, lifespanMs = EVERYONE_WARNING_LIFESPAN_MS) {
  await clearEveryoneWarning(key);

  let msg;
  try { msg = await channel.send({ content }); }
  catch (err) { console.error("[Warning] Failed to post @everyone:", err.message ?? err); return; }

  scheduleEveryoneWarningCycle(channel, key, content, msg, lifespanMs);
}

function scheduleEveryoneWarningCycle(channel, key, content, msg, lifespanMs = EVERYONE_WARNING_LIFESPAN_MS) {
  const repinDelay = lifespanMs - EVERYONE_REPIN_BEFORE_EXPIRE_MS;

  const repinTimer = repinDelay > 0 ? setTimeout(async () => {
    try {
      if (!everyoneWarnings[key]) return;
      everyoneWarnings[key].msg.delete().catch(() => {});

      let newMsg;
      try { newMsg = await channel.send({ content }); }
      catch { delete everyoneWarnings[key]; return; }

      everyoneWarnings[key].msg = newMsg;
      scheduleEveryoneWarningCycle(channel, key, content, newMsg, lifespanMs);
    } catch (err) {
      console.error("[Warning] repinTimer error:", err.message ?? err);
      delete everyoneWarnings[key];
    }
  }, repinDelay) : null;

  const deleteTimer = setTimeout(() => {
    if (!everyoneWarnings[key]) return;
    everyoneWarnings[key].msg.delete().catch(() => {});
    forwardToLogChannel(stripPings(everyoneWarnings[key].content));
    delete everyoneWarnings[key];
  }, lifespanMs);

  everyoneWarnings[key] = { msg, content, repinTimer, deleteTimer };
}

async function clearEveryoneWarning(key) {
  const w = everyoneWarnings[key];
  if (!w) return;
  if (w.repinTimer) clearTimeout(w.repinTimer);
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
    ? `⏳ Time left: **${formatSeconds(remaining)}**\n🟢 Opened: ${toServerTimeStr(windowStart)} (server) — <t:${tsStart}:t> (your time)\n🔴 Closes: ${toServerTimeStr(windowEnd)} (server) — <t:${tsEnd}:t> (your time)`
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
// DASHBOARD EMBED
// =====================
function buildEmbed() {
  const now   = Date.now();
  const embed = new EmbedBuilder()
    .setTitle("🔥 LIVE MU TRACKER")
    .setColor(0xffaa00)
    .setFooter({ text: "Auto-updates every 15s" });

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
      const tsRespawn = Math.floor(e.respawnTime    / 1000);
      const tsOpen    = Math.floor(nextWindowOpen   / 1000);
      const tsClose   = Math.floor(nextWindowClose  / 1000);
      const nextLine  = nextWindowClose > now
        ? `🔄 Next window: ${toServerTimeStr(nextWindowOpen)} – ${toServerTimeStr(nextWindowClose)} (server)\n    <t:${tsOpen}:t> — <t:${tsClose}:t> (your time)`
        : `🔄 Next window also passed — update manually`;
      text = [
        `⚠️ Timer possibly wrong`,
        `🕒 Last known respawn: ${toServerTimeStr(e.respawnTime)} (server) — <t:${tsRespawn}:t> (your time)`,
        nextLine,
        `👤 Last updated by: ${e.lastKiller}`,
      ].join("\n");
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
// REPIN DASHBOARD
// Guarded by repinInProgress lock to prevent concurrent repins.
// =====================
async function repinDashboard(channel) {
  if (repinInProgress) {
    console.log("[Repin] Already in progress, skipping.");
    return;
  }
  repinInProgress = true;

  try {
    const now = Date.now();

    // 1. Post new dashboard first (never leaves a gap)
    const newDashboard = await channel.send({
      embeds:     [buildEmbed()],
      components: buildButtons(),
      flags:      MessageFlags.SuppressNotifications
    }).catch(err => { console.error("[Repin] Failed to post dashboard:", err.message ?? err); return null; });

    if (!newDashboard) return;

    // 2. Delete old dashboard after new one is live
    if (dashboardMessage) dashboardMessage.delete().catch(() => {});
    dashboardMessage = newDashboard;

    // 3. Repost spawn window messages below the new dashboard
    for (const id of Object.keys(spawnWindowMessages)) {
      const w = spawnWindowMessages[id];
      if (w.msg) w.msg.delete().catch(() => {});

      if (w.windowEnd + WINDOW_GRACE_MS > now) {
        const newMsg = await channel.send({
          embeds:     [buildSpawnWindowEmbed(w.boss, w.windowStart, w.windowEnd)],
          components: buildSpawnWindowComponents(id),
          flags:      MessageFlags.SuppressNotifications
        }).catch(() => null);
        w.msg = newMsg;
      } else {
        delete spawnWindowMessages[id];
      }
    }

    // 4. Repost missed window messages below spawn windows
    for (const id of Object.keys(missedWindowMessages)) {
      const w = missedWindowMessages[id];

      if (w.nextWindowStart > now) {
        if (w.msg) { w.msg.delete().catch(() => {}); w.msg = null; }
        continue;
      }

      if (w.nextWindowEnd + WINDOW_GRACE_MS <= now) {
        if (w.msg) w.msg.delete().catch(() => {});
        delete missedWindowMessages[id];
        continue;
      }

      if (w.msg) w.msg.delete().catch(() => {});

      const newMsg = await channel.send({
        embeds:     [buildMissedWindowEmbed(w.boss, w.nextWindowStart, w.nextWindowEnd)],
        components: buildMissedWindowComponents(id),
        flags:      MessageFlags.SuppressNotifications
      }).catch(() => null);
      w.msg = newMsg;
    }

    console.log("[Repin] Dashboard stack refreshed.");
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

  const msg = await channel.send({
    embeds:     [buildSpawnWindowEmbed(boss, windowStart, windowEnd)],
    components: buildSpawnWindowComponents(id),
    flags:      MessageFlags.SuppressNotifications
  }).catch(err => { console.error(`[SpawnWindow] Failed to post for ${id}:`, err.message ?? err); return null; });

  if (!msg) return;

  const deleteAfter = (windowEnd - Date.now()) + WINDOW_GRACE_MS;
  const deleteTimer = setTimeout(() => {
    msg.delete().catch(() => {});
    delete spawnWindowMessages[id];
  }, Math.max(deleteAfter, 0));

  spawnWindowMessages[id] = { msg, windowStart, windowEnd, boss, deleteTimer };
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
    msg:          null,
    deleteTimer:  null,
    nextWindowStart,
    nextWindowEnd,
    pingedStart:  false,
    pinged1h:     false,
    pinged20min:  false,
    boss,
  };
}

// =====================
// MAIN LOOP
// Edits messages in place every tick.
// Only repins if the dashboard was deleted externally (error 10008).
// Repin is guarded by a lock to prevent concurrent runs.
// =====================
function startLoop() {
  setInterval(async () => {
    try {
      const channel = dashboardMessage
        ? dashboardMessage.channel
        : await client.channels.fetch(CHANNEL_ID).catch(() => null);

      if (!channel) return;

      const now = Date.now();

      // ── Repin only if dashboard was deleted externally ──
      if (!dashboardMessage) {
        if (!repinInProgress) {
          repinDashboard(channel); // intentionally not awaited — lock handles concurrency
        }
        checkWarnings(channel);
        await checkFixedEvents(channel);
        return;
      }

      // ── In-place edits (cheap, no chat spam) ──
      // Run sequentially rather than Promise.all so one failure doesn't cancel others
      try {
        await dashboardMessage.edit({ embeds: [buildEmbed()], components: buildButtons() });
      } catch (err) {
        if (err.code === 10008) {
          console.warn("[Loop] Dashboard message was deleted — will repin next tick.");
          dashboardMessage = null;
        } else if (err.status !== 503 && err.status !== 502) {
          console.error("[Loop] Dashboard edit failed:", err.code, err.message);
          // Force repin on unknown persistent errors (but not permission errors)
          if (err.code !== 50013) dashboardMessage = null;
        }
      }

      for (const [id, w] of Object.entries(spawnWindowMessages)) {
        if (!w.msg) continue;
        try {
          await w.msg.edit({
            embeds:     [buildSpawnWindowEmbed(w.boss, w.windowStart, w.windowEnd)],
            components: buildSpawnWindowComponents(id)
          });
        } catch (err) {
          if (err.code === 10008) delete spawnWindowMessages[id];
        }
      }

      for (const [id, w] of Object.entries(missedWindowMessages)) {
        if (!w.msg) continue;
        try {
          await w.msg.edit({
            embeds:     [buildMissedWindowEmbed(w.boss, w.nextWindowStart, w.nextWindowEnd)],
            components: buildMissedWindowComponents(id)
          });
        } catch (err) {
          if (err.code === 10008) delete missedWindowMessages[id];
        }
      }

      // ── Missed window pings ──
      tickMissedWindowPings(channel, now);

      // ── Boss warnings & fixed events ──
      checkWarnings(channel);
      await checkFixedEvents(channel);

    } catch (err) {
      console.error("[Loop] Tick error (recovered):", err.message ?? err);
    }
  }, TICK_RATE);
}

// =====================
// MISSED WINDOW PINGS
// =====================
function tickMissedWindowPings(channel, now) {
  for (const id of Object.keys(missedWindowMessages)) {
    const w = missedWindowMessages[id];
    const untilStart = w.nextWindowStart - now;
    const untilEnd   = w.nextWindowEnd   - now;

    if (untilStart <= 0 && !w.msg && untilEnd + WINDOW_GRACE_MS > 0) {
      channel.send({
        embeds:     [buildMissedWindowEmbed(w.boss, w.nextWindowStart, w.nextWindowEnd)],
        components: buildMissedWindowComponents(id),
        flags:      MessageFlags.SuppressNotifications
      }).then(msg => { w.msg = msg; }).catch(() => {});
    }

    if (!w.pingedStart && untilStart <= 0 && untilEnd > 0) {
      w.pingedStart = true;
      const tsClose = Math.floor(w.nextWindowEnd / 1000);
      const content =
        `@everyone 🔶 **${w.boss.name}** missed window is now open! ` +
        `Window closes in **${format(untilEnd)}** — ${toServerTimeStr(w.nextWindowEnd)} (server) — <t:${tsClose}:t> (your time)\n` +
        `⚠️ Timer might be incorrect — boss may take longer to respawn.`;
      postEveryoneWarning(channel, `${id}_missed_start`, content);
    }

    if (!w.pinged1h && untilEnd > 0 && untilEnd <= 60 * 60 * 1000) {
      w.pinged1h = true;
      const content =
        `@everyone ⏳ **${w.boss.name}** missed-window: **1 hour remaining** in the spawn window!\n` +
        `⚠️ This timer might be incorrect.`;
      postEveryoneWarning(channel, `${id}_missed_1h`, content);
    }

    if (!w.pinged20min && untilEnd > 0 && untilEnd <= 20 * 60 * 1000) {
      w.pinged20min = true;
      const content =
        `@everyone ⚠️ **${w.boss.name}** missed-window: **20 minutes remaining** in the spawn window!`;
      postEveryoneWarning(channel, `${id}_missed_20min`, content);
    }
  }
}

// =====================
// WARNING SYSTEM
// =====================
function checkWarnings(channel) {
  const now = Date.now();

  if (now - BOT_START_TIME < STARTUP_GRACE_MS) return;

  for (const b of BOSSES) {
    const e = data.kills[b.id];
    if (!e) continue;

    const cooldown               = e.respawnTime - now;
    const windowEnd              = e.respawnTime + 60 * 60 * 1000;
    const windowLeft             = windowEnd - now;
    const timeSinceWindowExpired = now - windowEnd;

    if (!spawnWarnings[b.id])
      spawnWarnings[b.id] = { warned5: false, warned20: false, windowCreated: false, missedHandled: false };

    const w = spawnWarnings[b.id];

    if (cooldown > 0 && cooldown <= 5 * 60 * 1000 && !w.warned5) {
      w.warned5 = true;
      if (!missedWindowMessages[b.id]) {
        postEveryoneWarning(channel, `${b.id}_5min`, `@everyone ⏳ **${b.name}** spawns in 5 minutes`, Math.max(cooldown, 0));
      }
    }

    if (cooldown <= 0 && windowLeft > 0 && !w.windowCreated) {
      w.windowCreated = true;
      clearEveryoneWarning(`${b.id}_5min`);
      if (!missedWindowMessages[b.id]) {
        createSpawnWindow(b, b.id, channel, windowEnd);
      }
    }

    if (cooldown <= 0 && windowLeft > 0 && windowLeft <= 20 * 60 * 1000 && !w.warned20) {
      w.warned20 = true;
      postEveryoneWarning(channel, `${b.id}_20min`, `@everyone ⚠️ **${b.name}** spawn window closes in 20 minutes!`);
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
// FIXED EVENT WARNINGS
// =====================
async function checkFixedEvents(channel) {
  const now = Date.now();

  for (const ev of FIXED_EVENTS) {
    for (const hhmm of ev.times) {
      const eventMs   = nextOccurrenceMs(hhmm, now);
      const warnMs    = ev.warnMinutes * 60 * 1000;
      const timeUntil = eventMs - now;

      // Track from (warnMs + 10min) so even if a tick is late we still catch it.
      // Key deduplication ensures only one ping per event occurrence.
      // Late ticks show actual remaining minutes instead of the configured warnMinutes.
      if (timeUntil > warnMs + (1 * 60 * 1000) || timeUntil < -(4 * 60 * 1000)) continue;

      const eventDate = new Date(eventMs).toLocaleDateString("en-CA", { timeZone: SERVER_TZ });
      const key       = `${ev.name}|${hhmm}|${eventDate}`;
      if (eventPingedKeys.has(key)) continue;
      eventPingedKeys.add(key);

      // Use actual remaining time so a late tick says "8 minutes" not wrong "10 minutes"
      const actualMins   = Math.max(1, Math.round(timeUntil / 60000));
      const eventTimeStr = toServerTimeStr(eventMs);
      const tsEvent      = Math.floor(eventMs / 1000);
      let msg =
        `@everyone ⏰ **${ev.name}** starts in **${actualMins} minute${actualMins !== 1 ? "s" : ""}**!\n` +
        `🕒 ${eventTimeStr} (server time) — <t:${tsEvent}:t> (your local time)`;
      if (ev.extraNote) msg += `\n${ev.extraNote}`;

      channel.send(msg).then(sent => {
        setTimeout(() => sent.delete().catch(() => {}), 5 * 60 * 1000);
      }).catch(() => {});
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
  clearEveryoneWarning(`${id}_missed_start`);
  clearEveryoneWarning(`${id}_missed_1h`);
  clearEveryoneWarning(`${id}_missed_20min`);
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

  try {
    await initBackupMessage(await client.channels.fetch(LOG_CHANNEL_ID));
  } catch (err) {
    console.error("[Backup] Could not init backup message in log channel:", err.message ?? err);
  }

  dashboardMessage = await channel.send({
    embeds:     [buildEmbed()],
    components: buildButtons(),
    flags:      MessageFlags.SuppressNotifications
  });

  startLoop();
  startBackupLoop();

  setTimeout(() => runBackup().catch(err => console.error("[Backup] Startup backup failed:", err.message ?? err)), 5000);
});

// =====================
// INTERACTIONS
// =====================
client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isButton() && !interaction.isStringSelectMenu() && !interaction.isModalSubmit()) return;

  // ── Throttled backup repost — at most once per minute ──
  if (Date.now() - lastBackupRepost > BACKUP_REPOST_COOLDOWN_MS) {
    lastBackupRepost = Date.now();
    repostBackupToBottom();
  }

  // ── KILL BUTTON ──
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

  // ── WINDOW KILL ──
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

  // ── WINDOW SET TIME — show modal ──
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

  // ── WINDOW SET TIME — modal submit ──
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

  // ── MISSED KILL ──
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

  // ── MISSED SET TIME — show modal ──
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

  // ── MISSED SET TIME — modal submit ──
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

  // ── INSERT TIME — boss picker ──
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

  // ── INSERT TIME — modal trigger ──
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

  // ── INSERT TIME — modal submit ──
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

  // ── RESET — picker ──
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

  // ── RESET — apply ──
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

  // ── UNDO ──
  if (interaction.isButton() && interaction.customId === "undo") {
    if (undo()) {
      log(interaction.user, `UNDO`);
      for (const id of Object.keys(spawnWarnings))
        spawnWarnings[id] = { warned5: false, warned20: false, windowCreated: false, missedHandled: false };
      await announceAdmin(interaction.channel, interaction.user, "used **undo**");
    }
    return interaction.deferUpdate();
  }

  // ── LOGS ──
  if (interaction.isButton() && interaction.customId === "show_logs") {
    return interaction.reply({
      embeds: [buildLogEmbed()],
      flags: MessageFlags.Ephemeral
    });
  }
});

client.login(TOKEN);
