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

const fs = require("fs");

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
const TICK_RATE  = 15000; // 15 seconds
const MAX_UNDO   = 10;

const EVERYONE_WARNING_LIFESPAN_MS = 10 * 60 * 1000;
const WINDOW_GRACE_MS              = 15 * 60 * 1000;

// =====================
// STATE
// =====================
let data = { kills: {} };
let dashboardMessage  = null;
let shadowDashMessage = null;

let spawnWarnings        = {};
let spawnWindowMessages  = {};
let missedWindowMessages = {};
let everyoneWarnings     = {};

let adminLogs = [];
let undoStack = [];

let backupMessage = null;
let logMessage    = null;

let missedCount      = {};
let repinInProgress  = false;
let lastBackupRepost = 0;
const BACKUP_REPOST_COOLDOWN_MS = 60 * 1000;

const BOT_START_TIME   = Date.now();
const STARTUP_GRACE_MS = 30 * 1000;

// =====================
// BOSSES — original
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
// SHADOW ABYSS BOSSES
// Each mob has 3 server instances (s1/s2/s3).
// type controls spawn behaviour:
//   "goblin"     — 10h respawn + 1h window (missed-window tracking, max 3 auto-advances)
//   "sa_fixed6"  — 6h fixed respawn        (missed-window tracking)
//   "sa_fixed12" — 12h fixed respawn       (missed-window tracking)
// =====================
const SA_SERVERS = [1, 2, 3];

const GOBLIN_QTY = {
  blue_goblin:   5,
  red_goblin:    4,
  yellow_goblin: 3,
};

const SA_RESPAWN_H = {
  goblin:     10,
  sa_fixed6:   6,
  sa_fixed12: 12,
};

const SA_GOBLIN_WINDOW_MS = 1 * 60 * 60 * 1000;
const SA_MAX_AUTO_ADVANCE = 3;

function buildShadowBosses() {
  const list = [];
  const defs = [
    { key: "blue_goblin",   label: "Blue Goblin",   type: "goblin"     },
    { key: "red_goblin",    label: "Red Goblin",     type: "goblin"     },
    { key: "yellow_goblin", label: "Yellow Goblin",  type: "goblin"     },
    { key: "red_dragon",    label: "Red Dragon",     type: "sa_fixed6"  },
    { key: "cursed_santa",  label: "Cursed Santa",   type: "sa_fixed6"  },
    { key: "white_wizard",  label: "White Wizard",   type: "sa_fixed12" },
    { key: "death_king",    label: "Death King",     type: "sa_fixed12" },
  ];
  for (const def of defs) {
    for (const s of SA_SERVERS) {
      list.push({
        id:     `sa_${def.key}_s${s}`,
        name:   `${def.label} S${s}`,
        label:  def.label,
        key:    def.key,
        server: s,
        type:   def.type,
      });
    }
  }
  return list;
}
const SHADOW_BOSSES = buildShadowBosses();

// =====================
// FIXED EVENTS
// =====================
const FIXED_EVENTS = [
  { name: "🟡 Golden Invasion",   times: ["00:31","04:31","08:31","12:31","16:31","20:31"], warnMinutes: 5 },
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
  // fallback (unreachable in practice but kept for safety)
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
// RESTORE WARNING FLAGS ON STARTUP
// =====================
function restoreSpawnWarningFlags() {
  const now = Date.now();

  for (const b of BOSSES) {
    const e = data.kills[b.id];
    if (!e) {
      spawnWarnings[b.id] = { warned5: false, warned20: false, windowCreated: false, missedHandled: false };
      continue;
    }
    const cooldown      = e.respawnTime - now;
    const windowEnd     = e.respawnTime + 60 * 60 * 1000;
    const windowExpired = now > windowEnd;
    spawnWarnings[b.id] = {
      warned5:       cooldown <= 5 * 60 * 1000,
      warned20:      cooldown <= 0 && (windowEnd - now) <= 20 * 60 * 1000,
      windowCreated: cooldown <= 0,
      missedHandled: windowExpired,
    };
    if (windowExpired && TRACKED_BOSS_TYPES.has(b.type)) {
      const nextWindowStart = e.respawnTime;
      const nextWindowEnd   = e.respawnTime + 2 * 60 * 60 * 1000;
      const untilEnd        = nextWindowEnd - now;
      if (untilEnd + WINDOW_GRACE_MS > 0) {
        missedWindowMessages[b.id] = {
          msg: null, deleteTimer: null,
          nextWindowStart, nextWindowEnd, boss: b,
          pingedStart: nextWindowStart <= now,
          pinged1h:    untilEnd <= 60 * 60 * 1000,
          pinged20min: untilEnd <= 20 * 60 * 1000,
        };
        console.log(`[Startup] Restored missed window state for ${b.name}`);
      }
    }
  }

  for (const b of SHADOW_BOSSES) {
    const e = data.kills[b.id];
    if (!e) {
      spawnWarnings[b.id] = { warned5: false, warned20: false, windowCreated: false, missedHandled: false };
      continue;
    }
    const cooldown      = e.respawnTime - now;
    const isGoblin      = b.type === "goblin";
    const windowEnd     = isGoblin ? e.respawnTime + SA_GOBLIN_WINDOW_MS : e.respawnTime;
    const windowExpired = now > windowEnd;
    spawnWarnings[b.id] = {
      warned5:       cooldown <= 5 * 60 * 1000,
      warned20:      isGoblin && cooldown <= 0 && (windowEnd - now) <= 20 * 60 * 1000,
      windowCreated: isGoblin && cooldown <= 0,
      missedHandled: windowExpired,
    };
    if (isGoblin && windowExpired) {
      const advanceCount = missedCount[b.id] || 0;
      if (advanceCount < SA_MAX_AUTO_ADVANCE) {
        const nextWindowStart = e.respawnTime;
        const nextWindowEnd   = e.respawnTime + SA_GOBLIN_WINDOW_MS + 60 * 60 * 1000;
        const untilEnd        = nextWindowEnd - now;
        if (untilEnd + WINDOW_GRACE_MS > 0) {
          missedWindowMessages[b.id] = {
            msg: null, deleteTimer: null,
            nextWindowStart, nextWindowEnd, boss: b,
            pingedStart: nextWindowStart <= now,
            pinged1h:    untilEnd <= 60 * 60 * 1000,
            pinged20min: untilEnd <= 20 * 60 * 1000,
            isShadow: true,
          };
          console.log(`[Startup] Restored SA missed window state for ${b.name}`);
        }
      }
    }
    if (!isGoblin && windowExpired) {
      const nextWindowStart = e.respawnTime;
      const nextWindowEnd   = e.respawnTime + 60 * 60 * 1000;
      const untilEnd        = nextWindowEnd - now;
      if (untilEnd + WINDOW_GRACE_MS > 0) {
        missedWindowMessages[b.id] = {
          msg: null, deleteTimer: null,
          nextWindowStart, nextWindowEnd, boss: b,
          pingedStart: nextWindowStart <= now,
          pinged1h:    false,
          pinged20min: untilEnd <= 20 * 60 * 1000,
          isShadow: true,
        };
        console.log(`[Startup] Restored SA fixed missed window state for ${b.name}`);
      }
    }
  }

  console.log("[Startup] Spawn warning flags restored.");
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

  console.log("[Recovery] Scanning Discord for latest backup...");
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
    const response   = await fetch(attachment.url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const json = await response.json();
    if (!json.kills) throw new Error("Backup JSON has no 'kills' field");
    const filtered = {};
    for (const [id, entry] of Object.entries(json.kills)) {
      if (entry.respawnTime >= now - 8 * 60 * 60 * 1000) filtered[id] = entry;
    }
    data = { kills: filtered };
    save();
    console.log(`[Recovery] Restored ${Object.keys(filtered).length} active timer(s).`);
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
// BACKUP — Discord
// =====================
function buildBackupEmbed(takenAt) {
  const stamp = toServerDateTimeStr(takenAt || Date.now());
  const lines = [
    ...BOSSES.map(b => {
      const e = data.kills[b.id];
      if (!e) return `• **${b.name}**: —`;
      return `• **${b.name}**: by ${e.lastKiller} — kill: ${toServerDateTimeStr(e.killTime)} — respawn: ${toServerDateTimeStr(e.respawnTime)}`;
    }),
    "",
    "**Shadow Abyss**",
    ...SHADOW_BOSSES.map(b => {
      const e = data.kills[b.id];
      if (!e) return `• **${b.name}**: —`;
      return `• **${b.name}**: by ${e.lastKiller} — kill: ${toServerDateTimeStr(e.killTime)} — respawn: ${toServerDateTimeStr(e.respawnTime)}`;
    }),
  ];
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
    if (found) { backupMessage = found; console.log("[Backup] Reusing existing backup message."); return; }
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
    await backupMessage.edit({ embeds: [buildBackupEmbed(Date.now())], files: [buildBackupFile()] });
    console.log("[Backup] Message updated.");
  } catch (err) {
    if (err.status === 503 || err.status === 502) {
      console.warn(`[Backup] Temporarily unavailable (${err.status}), retrying next cycle`);
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
    console.log("[Backup] Reposted.");
  } catch (err) {
    console.error("[Backup] Repost failed:", err.message ?? err);
  }
}

async function runBackup() {
  try { console.log(`[Backup] ${saveLocalBackup()}`); await updateDiscordBackup(); }
  catch (err) { console.error("[Backup]", err.message ?? err); }
}

function startBackupLoop() {
  const now = new Date();
  const msUntilNextHour = BACKUP_INTERVAL_MS -
    (now.getMinutes() * 60000 + now.getSeconds() * 1000 + now.getMilliseconds());
  console.log(`[Backup] First hourly update in ${Math.round(msUntilNextHour / 60000)}m.`);
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

function logBot(actionType) {
  adminLogs.unshift({ user: "🤖 BOT", action: actionType, time: Date.now() });
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
  setTimeout(() => { msg.delete().catch(() => {}); forwardToLogChannel(stripPings(content)); }, 5 * 60 * 1000);
}

async function announceAdmin(channel, user, action) {
  const content = `📢 **${user.username}** ${action} — ${toServerDateTimeStr(Date.now())} (server time)`;
  const msg     = await channel.send({ content, flags: MessageFlags.SuppressNotifications });
  setTimeout(() => { msg.delete().catch(() => {}); forwardToLogChannel(stripPings(content)); }, 5 * 60 * 1000);
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
  const deleteTimer = setTimeout(() => {
    if (!everyoneWarnings[key]) return;
    everyoneWarnings[key].msg.delete().catch(() => {});
    forwardToLogChannel(stripPings(everyoneWarnings[key].content));
    delete everyoneWarnings[key];
  }, lifespanMs);
  everyoneWarnings[key] = { msg, content, deleteTimer };
}

async function clearEveryoneWarning(key) {
  const w = everyoneWarnings[key];
  if (!w) return;
  clearTimeout(w.deleteTimer);
  w.msg.delete().catch(() => {});
  delete everyoneWarnings[key];
}

// =====================
// SPAWN WINDOW EMBEDS & COMPONENTS — original bosses
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
// MISSED WINDOW EMBEDS & COMPONENTS — original bosses
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
// SHADOW ABYSS — SPAWN WINDOW EMBEDS & COMPONENTS (goblins)
// =====================
function buildSASpawnWindowEmbed(boss, windowStart, windowEnd) {
  const remaining = windowEnd - Date.now();
  const tsStart   = Math.floor(windowStart / 1000);
  const tsEnd     = Math.floor(windowEnd / 1000);
  const qtyLine   = GOBLIN_QTY[boss.key] ? `👥 Quantity: **${GOBLIN_QTY[boss.key]}**\n` : "";
  const desc = remaining > 0
    ? `${qtyLine}⏳ Time left: **${formatSeconds(remaining)}**\n🟢 Opened: ${toServerTimeStr(windowStart)} (server) — <t:${tsStart}:t> (your time)\n🔴 Closes: ${toServerTimeStr(windowEnd)} (server) — <t:${tsEnd}:t> (your time)`
    : `${qtyLine}⌛ Window has closed — log the kill or wait for next respawn\n🟢 Opened: ${toServerTimeStr(windowStart)} (server) — <t:${tsStart}:t> (your time)\n🔴 Closed: ${toServerTimeStr(windowEnd)} (server) — <t:${tsEnd}:t> (your time)`;
  return new EmbedBuilder()
    .setTitle(`🟢 [Shadow Abyss] ${boss.name} — Spawn window active`)
    .setColor(0x00aaff)
    .setDescription(desc);
}

function buildSASpawnWindowComponents(id) {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("sa_window_kill_"    + id).setLabel("💀 Killed").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("sa_window_settime_" + id).setLabel("⏱️ Set Time").setStyle(ButtonStyle.Secondary)
  )];
}

// =====================
// SHADOW ABYSS — MISSED WINDOW EMBEDS & COMPONENTS
// =====================
function buildSAMissedWindowEmbed(boss, windowStart, windowEnd, advanceCount) {
  const now        = Date.now();
  const untilStart = windowStart - now;
  const untilEnd   = windowEnd   - now;
  const isLocked   = advanceCount >= SA_MAX_AUTO_ADVANCE;
  const qtyLine    = GOBLIN_QTY[boss.key] ? `👥 Quantity: **${GOBLIN_QTY[boss.key]}**\n` : "";
  let statusLine;
  if (isLocked) {
    statusLine = `🔒 **Timer locked** — ${SA_MAX_AUTO_ADVANCE}/${SA_MAX_AUTO_ADVANCE} windows missed. Update manually.`;
  } else if (untilStart > 0) {
    const tsOpen = Math.floor(windowStart / 1000);
    statusLine = `⏳ Next possible window in: **${format(untilStart)}**\n🕒 Opens at: ${toServerTimeStr(windowStart)} (server) — <t:${tsOpen}:t> (your time)`;
  } else if (untilEnd > 0) {
    const tsClose = Math.floor(windowEnd / 1000);
    statusLine = `🟡 **WINDOW OPEN** — closes in: **${format(untilEnd)}**\n🕒 Closes: ${toServerTimeStr(windowEnd)} (server) — <t:${tsClose}:t> (your time)`;
  } else {
    statusLine = `⚠️ Window has closed with no kill recorded.`;
  }
  const countLabel = `⚠️ Missed: **${advanceCount}/${SA_MAX_AUTO_ADVANCE}**${isLocked ? " — 🔒 Locked, update manually!" : ""}`;
  return new EmbedBuilder()
    .setTitle(`⚠️ [Shadow Abyss] ${boss.name} — Possible wrong timer`)
    .setColor(isLocked ? 0xff0000 : 0xff6600)
    .setDescription(
      `${qtyLine}${statusLine}\n\n${countLabel}\n` +
      `> ⚠️ **This timer might be incorrect.**\n` +
      `> The previous window passed without a kill being logged.`
    )
    .setFooter({ text: `Auto-updating | Window: ${toServerTimeStr(windowStart)} – ${toServerTimeStr(windowEnd)} (server)` });
}

function buildSAMissedWindowComponents(id) {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("sa_missed_kill_"    + id).setLabel("💀 Killed").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("sa_missed_settime_" + id).setLabel("⏱️ Set Time").setStyle(ButtonStyle.Secondary)
  )];
}

// =====================
// DASHBOARD EMBED — original bosses
// =====================
function buildEmbed() {
  const now   = Date.now();
  const embed = new EmbedBuilder()
    .setTitle("🔥 LIVE MU TRACKER")
    .setColor(0xffaa00)
    .setFooter({ text: "Auto-updates every 15s" });

  const bosses = BOSSES.map(b => {
    const e = data.kills[b.id];
    if (!e) return { name: b.name, timeLeft: 0, text: `🟢 READY\n👤 None`, isBroken: false };
    const cooldown    = e.respawnTime - now;
    const windowEnd   = e.respawnTime + 60 * 60 * 1000;
    const windowLeft  = windowEnd - now;
    const isMissed    = !!missedWindowMessages[b.id];
    const missedTimes = missedCount[b.id] || 0;
    const missedLabel = missedTimes >= 2
      ? `⚠️ Timer wrong (${missedTimes}x missed) — update manually!`
      : `⚠️ Timer possibly wrong (1st miss)`;
    let text, isBroken = false;

    if (cooldown > 0) {
      const tsRespawn = Math.floor(e.respawnTime / 1000);
      if (isMissed) {
        const missedNote = missedTimes >= 2
          ? `🚨 Missed ${missedTimes}x in a row — probably needs update manually!`
          : `1st missed window — timer may be off`;
        text = [
          `⚠️ Timer possibly wrong — waiting for respawn`,
          missedNote,
          `🕒 Expected: ${toServerTimeStr(e.respawnTime)} (server) — <t:${tsRespawn}:t> (your time)`,
          `⏳ Time left: ${format(cooldown)}`,
          `👤 Last updated by: ${e.lastKiller}`,
        ].join('\n');
        isBroken = true;
      } else {
        text = `🔴 ${format(cooldown)}\n🕒 ${toServerTimeStr(e.respawnTime)} (server) — <t:${tsRespawn}:t> (your time)\n👤 ${e.lastKiller}`;
      }
    } else if (windowLeft > 0) {
      const tsRespawn = Math.floor(e.respawnTime / 1000);
      text = `🟢 WINDOW — ⏳ ${format(windowLeft)}\n🕒 Was due: ${toServerTimeStr(e.respawnTime)} (server) — <t:${tsRespawn}:t> (your time)\n👤 ${e.lastKiller}`;
    } else {
      const nextWindowOpen  = e.respawnTime + 60 * 60 * 1000;
      const nextWindowClose = e.respawnTime + 2 * 60 * 60 * 1000;
      const tsRespawn = Math.floor(e.respawnTime   / 1000);
      const tsOpen    = Math.floor(nextWindowOpen  / 1000);
      const tsClose   = Math.floor(nextWindowClose / 1000);
      const nextLine  = nextWindowClose > now
        ? `🔄 Next window: ${toServerTimeStr(nextWindowOpen)} – ${toServerTimeStr(nextWindowClose)} (server)\n    <t:${tsOpen}:t> — <t:${tsClose}:t> (your time)`
        : `🔄 Next window also passed — update manually`;
      text = [
        missedLabel,
        `🕒 Last known respawn: ${toServerTimeStr(e.respawnTime)} (server) — <t:${tsRespawn}:t> (your time)`,
        nextLine,
        `👤 Last updated by: ${e.lastKiller}`,
      ].join('\n');
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
// SHADOW ABYSS DASHBOARD EMBED
// — Goblins section (with window tracking)
// — World Bosses section (fixed respawn, per server)
// =====================
function buildShadowEmbed() {
  const now   = Date.now();
  const embed = new EmbedBuilder()
    .setTitle("🌑 SHADOW ABYSS TRACKER")
    .setColor(0x7b00ff)
    .setFooter({ text: "Auto-updates every 15s" });

  const goblinKeys = [...new Set(SHADOW_BOSSES.filter(b => b.type === "goblin").map(b => b.key))];
  const fixedKeys  = [...new Set(SHADOW_BOSSES.filter(b => b.type !== "goblin").map(b => b.key))];

  // ── Goblin section ──
  embed.addFields({ name: "👺 ─── Goblins ───", value: "\u200B" });

  for (const key of goblinKeys) {
    const bossesForKey = SHADOW_BOSSES.filter(b => b.key === key);
    const first        = bossesForKey[0];
    const respawnH     = SA_RESPAWN_H[first.type];
    const qtyStr       = GOBLIN_QTY[key] ? ` (x${GOBLIN_QTY[key]})` : "";
    const headerLabel  = `${first.label}${qtyStr} — ${respawnH}h respawn +1h window`;

    const lines = bossesForKey.map(b => {
      const e        = data.kills[b.id];
      const advCount = missedCount[b.id] || 0;
      const lockedStr = advCount >= SA_MAX_AUTO_ADVANCE ? " 🔒" : "";
      if (!e) return `**S${b.server}**: 🟢 READY`;
      const cooldown   = e.respawnTime - now;
      const windowEnd  = e.respawnTime + SA_GOBLIN_WINDOW_MS;
      const windowLeft = windowEnd - now;
      const tsRespawn  = Math.floor(e.respawnTime / 1000);
      if (cooldown > 0) {
        const isMissed = !!missedWindowMessages[b.id];
        if (isMissed) return `**S${b.server}**: ⚠️ ${format(cooldown)} (${advCount}/${SA_MAX_AUTO_ADVANCE} missed)${lockedStr} — <t:${tsRespawn}:t>`;
        return `**S${b.server}**: 🔴 ${format(cooldown)} — <t:${tsRespawn}:t>`;
      }
      if (windowLeft > 0) return `**S${b.server}**: 🟢 WINDOW ⏳ ${format(windowLeft)} — was due <t:${tsRespawn}:t>`;
      if (advCount >= SA_MAX_AUTO_ADVANCE) return `**S${b.server}**: 🔒 LOCKED (${advCount}/${SA_MAX_AUTO_ADVANCE} missed) — update manually`;
      return `**S${b.server}**: ⚠️ MISSED (${advCount}/${SA_MAX_AUTO_ADVANCE}) — <t:${tsRespawn}:t>`;
    });

    embed.addFields({ name: `• ${headerLabel}`, value: lines.join("\n") });
  }

  // ── World Bosses section ──
  embed.addFields({ name: "👹 ─── World Bosses ───", value: "\u200B" });

  for (const key of fixedKeys) {
    const bossesForKey = SHADOW_BOSSES.filter(b => b.key === key);
    const first        = bossesForKey[0];
    const respawnH     = SA_RESPAWN_H[first.type];
    const headerLabel  = `${first.label} — ${respawnH}h respawn`;

    const lines = bossesForKey.map(b => {
      const e        = data.kills[b.id];
      const advCount = missedCount[b.id] || 0;
      if (!e) return `**S${b.server}**: 🟢 READY`;
      const cooldown   = e.respawnTime - now;
      const tsRespawn  = Math.floor(e.respawnTime / 1000);
      // Still alive / counting down
      if (cooldown > 0) {
        const isMissed = !!missedWindowMessages[b.id];
        if (isMissed) return `**S${b.server}**: ⚠️ ${format(cooldown)} (${advCount} missed) — <t:${tsRespawn}:t>`;
        return `**S${b.server}**: 🔴 ${format(cooldown)} — <t:${tsRespawn}:t>`;
      }
      // Within 5-min grace window — shows as "spawned, log it"
      if (cooldown >= -5 * 60 * 1000) return `**S${b.server}**: 🟡 SPAWNED — <t:${tsRespawn}:t> — log kill!`;
      // Past grace — missed
      return `**S${b.server}**: ⚠️ MISSED (${advCount}x) — was <t:${tsRespawn}:t>`;
    });

    embed.addFields({ name: `• ${headerLabel}`, value: lines.join("\n") });
  }

  return embed;
}

// =====================
// SHADOW ABYSS BUTTONS
// Row 1: Goblin type buttons (Primary / blue)
// Row 2: Fixed world boss buttons (Secondary / grey)
// Row 3: Utility buttons
// =====================
function buildShadowButtons() {
  const rows = [];

  const goblinKeys = [...new Set(SHADOW_BOSSES.filter(b => b.type === "goblin").map(b => b.key))];
  const fixedKeys  = [...new Set(SHADOW_BOSSES.filter(b => b.type !== "goblin").map(b => b.key))];

  // Row 1 — Goblins (up to 5 per row, chunked if needed)
  for (let i = 0; i < goblinKeys.length; i += 5) {
    const row = new ActionRowBuilder();
    for (const key of goblinKeys.slice(i, i + 5)) {
      const label = SHADOW_BOSSES.find(b => b.key === key).label;
      row.addComponents(
        new ButtonBuilder()
          .setCustomId("sa_kill_type_" + key)
          .setLabel(label.slice(0, 20))
          .setStyle(ButtonStyle.Primary)
      );
    }
    rows.push(row);
  }

  // Row 2 — Fixed world bosses (up to 5 per row, chunked if needed)
  for (let i = 0; i < fixedKeys.length; i += 5) {
    const row = new ActionRowBuilder();
    for (const key of fixedKeys.slice(i, i + 5)) {
      const label = SHADOW_BOSSES.find(b => b.key === key).label;
      row.addComponents(
        new ButtonBuilder()
          .setCustomId("sa_kill_type_" + key)
          .setLabel(label.slice(0, 20))
          .setStyle(ButtonStyle.Secondary)
      );
    }
    rows.push(row);
  }

  // Row 3 — Utility
  rows.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("sa_insert_time").setLabel("📝 Insert").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("sa_reset").setLabel("🧹 Reset").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("sa_undo").setLabel("↩️ Undo").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("show_logs").setLabel("📜 Logs").setStyle(ButtonStyle.Secondary)
  ));

  return rows;
}

// =====================
// BUTTONS — original bosses
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
// REPIN DASHBOARD (both dashboards)
// =====================
async function repinDashboard(channel) {
  if (repinInProgress) { console.log("[Repin] Already in progress, skipping."); return; }
  repinInProgress = true;
  try {
    const now = Date.now();

    const newDashboard = await channel.send({
      embeds: [buildEmbed()], components: buildButtons(), flags: MessageFlags.SuppressNotifications
    }).catch(err => { console.error("[Repin] Failed to post dashboard:", err.message ?? err); return null; });
    if (!newDashboard) return;
    if (dashboardMessage) dashboardMessage.delete().catch(() => {});
    dashboardMessage = newDashboard;

    const newShadowDash = await channel.send({
      embeds: [buildShadowEmbed()], components: buildShadowButtons(), flags: MessageFlags.SuppressNotifications
    }).catch(err => { console.error("[Repin] Failed to post shadow dashboard:", err.message ?? err); return null; });
    if (newShadowDash) {
      if (shadowDashMessage) shadowDashMessage.delete().catch(() => {});
      shadowDashMessage = newShadowDash;
    }

    for (const id of Object.keys(spawnWindowMessages)) {
      const w = spawnWindowMessages[id];
      if (w.msg) w.msg.delete().catch(() => {});
      if (w.windowEnd + WINDOW_GRACE_MS > now) {
        w.msg = await channel.send({
          embeds: [w.isShadow
            ? buildSASpawnWindowEmbed(w.boss, w.windowStart, w.windowEnd)
            : buildSpawnWindowEmbed(w.boss, w.windowStart, w.windowEnd)],
          components: w.isShadow
            ? buildSASpawnWindowComponents(id)
            : buildSpawnWindowComponents(id),
          flags: MessageFlags.SuppressNotifications
        }).catch(() => null);
      } else { delete spawnWindowMessages[id]; }
    }

    for (const id of Object.keys(missedWindowMessages)) {
      const w = missedWindowMessages[id];
      if (w.nextWindowStart > now) { if (w.msg) { w.msg.delete().catch(() => {}); w.msg = null; } continue; }
      if (w.nextWindowEnd + WINDOW_GRACE_MS <= now) { if (w.msg) w.msg.delete().catch(() => {}); delete missedWindowMessages[id]; continue; }
      if (w.msg) w.msg.delete().catch(() => {});
      const advCount = missedCount[id] || 0;
      if (w.isShadow) {
        w.msg = await channel.send({
          embeds: [buildSAMissedWindowEmbed(w.boss, w.nextWindowStart, w.nextWindowEnd, advCount)],
          components: buildSAMissedWindowComponents(id), flags: MessageFlags.SuppressNotifications
        }).catch(() => null);
      } else {
        w.msg = await channel.send({
          embeds: [buildMissedWindowEmbed(w.boss, w.nextWindowStart, w.nextWindowEnd)],
          components: buildMissedWindowComponents(id), flags: MessageFlags.SuppressNotifications
        }).catch(() => null);
      }
    }

    console.log("[Repin] Dashboard stack refreshed.");
  } finally { repinInProgress = false; }
}

// =====================
// SPAWN WINDOW CREATION — original bosses
// =====================
async function createSpawnWindow(boss, id, channel, windowEnd) {
  if (spawnWindowMessages[id]) return;
  const windowStart = windowEnd - 60 * 60 * 1000;
  const msg = await channel.send({
    embeds: [buildSpawnWindowEmbed(boss, windowStart, windowEnd)],
    components: buildSpawnWindowComponents(id), flags: MessageFlags.SuppressNotifications
  }).catch(err => { console.error(`[SpawnWindow] Failed for ${id}:`, err.message ?? err); return null; });
  if (!msg) return;
  const deleteAfter = (windowEnd - Date.now()) + WINDOW_GRACE_MS;
  const deleteTimer = setTimeout(() => { msg.delete().catch(() => {}); delete spawnWindowMessages[id]; }, Math.max(deleteAfter, 0));
  spawnWindowMessages[id] = { msg, windowStart, windowEnd, boss, deleteTimer };
}

// =====================
// SPAWN WINDOW CREATION — Shadow Abyss goblins
// =====================
async function createSASpawnWindow(boss, id, channel, windowEnd) {
  if (spawnWindowMessages[id]) return;
  const windowStart = windowEnd - SA_GOBLIN_WINDOW_MS;
  const msg = await channel.send({
    embeds: [buildSASpawnWindowEmbed(boss, windowStart, windowEnd)],
    components: buildSASpawnWindowComponents(id), flags: MessageFlags.SuppressNotifications
  }).catch(err => { console.error(`[SA SpawnWindow] Failed for ${id}:`, err.message ?? err); return null; });
  if (!msg) return;
  const deleteAfter = (windowEnd - Date.now()) + WINDOW_GRACE_MS;
  const deleteTimer = setTimeout(() => { msg.delete().catch(() => {}); delete spawnWindowMessages[id]; }, Math.max(deleteAfter, 0));
  spawnWindowMessages[id] = { msg, windowStart, windowEnd, boss, deleteTimer, isShadow: true };
}

// =====================
// MISSED WINDOW / AUTO-ADVANCE — original bosses
// FIX: set killTime BEFORE mutating respawnTime
// =====================
async function handleMissedWindow(boss, id, channel) {
  const e = data.kills[id];
  if (!e) return;
  missedCount[id] = (missedCount[id] || 0) + 1;
  const count = missedCount[id];
  console.log(`[MissedWindow] No kill for ${boss.name} — auto-advancing 7h (advance #${count})`);
  snapshot();
  // FIX: capture old respawnTime as the "kill" moment before advancing
  e.killTime    = e.respawnTime;
  e.respawnTime = e.respawnTime + 7 * 60 * 60 * 1000;
  save();
  logBot(`AUTO-ADVANCE ${boss.name} — missed window #${count} — new respawn: ${toServerDateTimeStr(e.respawnTime)}`);
  spawnWarnings[id] = { warned5: false, warned20: false, windowCreated: false, missedHandled: false };
  clearBossCards(id, false);
  const nextWindowStart = e.respawnTime;
  const nextWindowEnd   = e.respawnTime + 2 * 60 * 60 * 1000;
  missedWindowMessages[id] = {
    msg: null, deleteTimer: null,
    nextWindowStart, nextWindowEnd,
    pingedStart: false, pinged1h: false, pinged20min: false, boss,
  };
  if (count >= 2) {
    const tsOpen  = Math.floor(nextWindowStart / 1000);
    const tsClose = Math.floor(nextWindowEnd   / 1000);
    const content =
      `@everyone 🚨 **${boss.name}** has missed its spawn window **${count} times** in a row!\n` +
      `The timer is likely wrong — please find and kill the boss to reset it.\n` +
      `📍 Next estimated window: ${toServerTimeStr(nextWindowStart)} – ${toServerTimeStr(nextWindowEnd)} (server)\n` +
      `<t:${tsOpen}:t> — <t:${tsClose}:t> (your time)`;
    postEveryoneWarning(channel, `${id}_stale_timer`, content, 30 * 60 * 1000);
  }
}

// =====================
// MISSED WINDOW / AUTO-ADVANCE — Shadow Abyss goblin-type
// FIX: set killTime BEFORE mutating respawnTime
// =====================
async function handleSAMissedWindowGoblin(boss, id, channel) {
  const e = data.kills[id];
  if (!e) return;
  const count = (missedCount[id] || 0) + 1;
  missedCount[id] = count;
  if (count > SA_MAX_AUTO_ADVANCE) {
    console.log(`[SA MissedWindow] ${boss.name} already at max advances (${SA_MAX_AUTO_ADVANCE}), skipping.`);
    return;
  }
  console.log(`[SA MissedWindow] No kill for ${boss.name} — auto-advancing ${SA_RESPAWN_H.goblin}h (advance #${count})`);
  snapshot();
  const respawnMs = SA_RESPAWN_H.goblin * 60 * 60 * 1000;
  // FIX: capture old respawnTime as the "kill" moment before advancing
  e.killTime    = e.respawnTime;
  e.respawnTime = e.respawnTime + respawnMs;
  save();
  logBot(`SA AUTO-ADVANCE ${boss.name} — missed window #${count}/${SA_MAX_AUTO_ADVANCE} — new respawn: ${toServerDateTimeStr(e.respawnTime)}${count >= SA_MAX_AUTO_ADVANCE ? " — 🔒 LOCKED" : ""}`);
  spawnWarnings[id] = { warned5: false, warned20: false, windowCreated: false, missedHandled: false };
  clearSABossCards(id, false);
  const nextWindowStart = e.respawnTime;
  const nextWindowEnd   = e.respawnTime + SA_GOBLIN_WINDOW_MS + 60 * 60 * 1000;
  missedWindowMessages[id] = {
    msg: null, deleteTimer: null,
    nextWindowStart, nextWindowEnd,
    pingedStart: false, pinged1h: false, pinged20min: false, boss, isShadow: true,
  };
  const tsOpen  = Math.floor(nextWindowStart / 1000);
  const tsClose = Math.floor(nextWindowEnd   / 1000);
  if (count >= SA_MAX_AUTO_ADVANCE) {
    postEveryoneWarning(channel, `${id}_sa_locked`,
      `@everyone 🔒 **[Shadow Abyss] ${boss.name}** has missed its spawn window **${count}/${SA_MAX_AUTO_ADVANCE} times** — TIMER LOCKED!\n` +
      `⚠️ Please find the boss and manually update the timer.\n` +
      `📍 Last estimated window: ${toServerTimeStr(nextWindowStart)} – ${toServerTimeStr(nextWindowEnd)} (server)\n` +
      `<t:${tsOpen}:t> — <t:${tsClose}:t> (your time)`,
      30 * 60 * 1000);
  } else {
    postEveryoneWarning(channel, `${id}_sa_stale_${count}`,
      `@everyone ⚠️ **[Shadow Abyss] ${boss.name}** missed window #${count}/${SA_MAX_AUTO_ADVANCE}.\n` +
      `📍 Next estimated window: ${toServerTimeStr(nextWindowStart)} – ${toServerTimeStr(nextWindowEnd)} (server)\n` +
      `<t:${tsOpen}:t> — <t:${tsClose}:t> (your time)`,
      30 * 60 * 1000);
  }
}

// =====================
// MISSED WINDOW — Shadow Abyss fixed-respawn types
// No auto-advance; just post alert and create missed message
// =====================
async function handleSAMissedWindowFixed(boss, id, channel) {
  const e = data.kills[id];
  if (!e) return;
  const count = (missedCount[id] || 0) + 1;
  missedCount[id] = count;
  console.log(`[SA MissedWindow Fixed] ${boss.name} — missed #${count}`);
  logBot(`SA MISSED SPAWN ${boss.name} — no kill logged (miss #${count}) — was due: ${toServerDateTimeStr(e.respawnTime)}`);
  const nextWindowStart = e.respawnTime;
  const nextWindowEnd   = e.respawnTime + 60 * 60 * 1000;
  if (!missedWindowMessages[id]) {
    missedWindowMessages[id] = {
      msg: null, deleteTimer: null,
      nextWindowStart, nextWindowEnd,
      pingedStart: true, pinged1h: false, pinged20min: false, boss, isShadow: true,
    };
  }
  const tsRespawn = Math.floor(e.respawnTime / 1000);
  postEveryoneWarning(channel, `${id}_sa_fixed_missed_${count}`,
    `@everyone 🚨 **[Shadow Abyss] ${boss.name}** spawned but no kill was logged!\n` +
    `🕒 Was due: ${toServerTimeStr(e.respawnTime)} (server) — <t:${tsRespawn}:t>\n` +
    `Please log the kill using the ⏱️ Set Time button.`,
    20 * 60 * 1000);
}

// =====================
// MAIN LOOP
// =====================
function startLoop() {
  setInterval(async () => {
    try {
      const channel = dashboardMessage
        ? dashboardMessage.channel
        : await client.channels.fetch(CHANNEL_ID).catch(() => null);
      if (!channel) return;

      const now = Date.now();

      if (!dashboardMessage) {
        if (!repinInProgress) repinDashboard(channel);
        checkWarnings(channel);
        checkSAWarnings(channel);
        await checkFixedEvents(channel);
        return;
      }

      // Update original dashboard
      try {
        await dashboardMessage.edit({ embeds: [buildEmbed()], components: buildButtons() });
      } catch (err) {
        if (err.code === 10008) { console.warn("[Loop] Dashboard deleted — repinning."); dashboardMessage = null; }
        else if (err.status !== 503 && err.status !== 502) {
          console.error("[Loop] Dashboard edit failed:", err.code, err.message);
          if (err.code !== 50013) dashboardMessage = null;
        }
      }

      // Update Shadow Abyss dashboard
      if (shadowDashMessage) {
        try {
          await shadowDashMessage.edit({ embeds: [buildShadowEmbed()], components: buildShadowButtons() });
        } catch (err) {
          if (err.code === 10008) { console.warn("[Loop] Shadow dashboard deleted — will repin."); shadowDashMessage = null; }
          else if (err.status !== 503 && err.status !== 502)
            console.error("[Loop] Shadow dashboard edit failed:", err.code, err.message);
        }
      }

      for (const [id, w] of Object.entries(spawnWindowMessages)) {
        if (!w.msg) continue;
        try {
          if (w.isShadow) {
            await w.msg.edit({ embeds: [buildSASpawnWindowEmbed(w.boss, w.windowStart, w.windowEnd)], components: buildSASpawnWindowComponents(id) });
          } else {
            await w.msg.edit({ embeds: [buildSpawnWindowEmbed(w.boss, w.windowStart, w.windowEnd)], components: buildSpawnWindowComponents(id) });
          }
        } catch (err) { if (err.code === 10008) delete spawnWindowMessages[id]; }
      }

      for (const [id, w] of Object.entries(missedWindowMessages)) {
        if (!w.msg) continue;
        const advCount = missedCount[id] || 0;
        try {
          if (w.isShadow) {
            await w.msg.edit({ embeds: [buildSAMissedWindowEmbed(w.boss, w.nextWindowStart, w.nextWindowEnd, advCount)], components: buildSAMissedWindowComponents(id) });
          } else {
            await w.msg.edit({ embeds: [buildMissedWindowEmbed(w.boss, w.nextWindowStart, w.nextWindowEnd)], components: buildMissedWindowComponents(id) });
          }
        } catch (err) { if (err.code === 10008) delete missedWindowMessages[id]; }
      }

      tickMissedWindowPings(channel, now);
      checkWarnings(channel);
      checkSAWarnings(channel);
      await checkFixedEvents(channel);

    } catch (err) { console.error("[Loop] Tick error:", err.message ?? err); }
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
      const advCount = missedCount[id] || 0;
      const sendOpts = w.isShadow
        ? { embeds: [buildSAMissedWindowEmbed(w.boss, w.nextWindowStart, w.nextWindowEnd, advCount)], components: buildSAMissedWindowComponents(id), flags: MessageFlags.SuppressNotifications }
        : { embeds: [buildMissedWindowEmbed(w.boss, w.nextWindowStart, w.nextWindowEnd)], components: buildMissedWindowComponents(id), flags: MessageFlags.SuppressNotifications };
      channel.send(sendOpts).then(msg => { w.msg = msg; }).catch(() => {});
    }

    if (!w.isShadow) {
      if (!w.pingedStart && untilStart <= 0 && untilEnd > 0) {
        w.pingedStart = true;
        const tsClose = Math.floor(w.nextWindowEnd / 1000);
        postEveryoneWarning(channel, `${id}_missed_start`,
          `@everyone 🔶 **${w.boss.name}** missed window is now open! ` +
          `Window closes in **${format(untilEnd)}** — ${toServerTimeStr(w.nextWindowEnd)} (server) — <t:${tsClose}:t> (your time)\n` +
          `⚠️ Timer might be incorrect — boss may take longer to respawn.`);
      }
      if (!w.pinged1h && untilEnd > 0 && untilEnd <= 60 * 60 * 1000) {
        w.pinged1h = true;
        postEveryoneWarning(channel, `${id}_missed_1h`,
          `@everyone ⏳ **${w.boss.name}** missed-window: **1 hour remaining**!\n⚠️ This timer might be incorrect.`);
      }
      if (!w.pinged20min && untilEnd > 0 && untilEnd <= 20 * 60 * 1000) {
        w.pinged20min = true;
        postEveryoneWarning(channel, `${id}_missed_20min`,
          `@everyone ⚠️ **${w.boss.name}** missed-window: **20 minutes remaining** in the spawn window!`);
      }
    } else {
      if (!w.pingedStart && untilStart <= 0 && untilEnd > 0) {
        w.pingedStart = true;
        const tsClose  = Math.floor(w.nextWindowEnd / 1000);
        const advCount = missedCount[id] || 0;
        postEveryoneWarning(channel, `${id}_sa_missed_start`,
          `@everyone 🔶 **[Shadow Abyss] ${w.boss.name}** missed window is now open! ` +
          `Closes in **${format(untilEnd)}** — <t:${tsClose}:t>\n` +
          `⚠️ Missed: ${advCount}/${SA_MAX_AUTO_ADVANCE} — timer might be incorrect.`);
      }
      if (!w.pinged20min && untilEnd > 0 && untilEnd <= 20 * 60 * 1000) {
        w.pinged20min = true;
        const advCount = missedCount[id] || 0;
        postEveryoneWarning(channel, `${id}_sa_missed_20min`,
          `@everyone ⚠️ **[Shadow Abyss] ${w.boss.name}** missed-window: **20 minutes remaining**! (${advCount}/${SA_MAX_AUTO_ADVANCE} missed)`);
      }
    }
  }
}

// =====================
// WARNING SYSTEM — original bosses
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
      if (!missedWindowMessages[b.id])
        postEveryoneWarning(channel, `${b.id}_5min`, `@everyone ⏳ **${b.name}** spawns in 5 minutes`, Math.max(cooldown, 0));
    }
    if (cooldown <= 0 && windowLeft > 0 && !w.windowCreated) {
      w.windowCreated = true;
      clearEveryoneWarning(`${b.id}_5min`);
      if (!missedWindowMessages[b.id]) createSpawnWindow(b, b.id, channel, windowEnd);
    }
    if (cooldown <= 0 && windowLeft > 0 && windowLeft <= 20 * 60 * 1000 && !w.warned20) {
      w.warned20 = true;
      postEveryoneWarning(channel, `${b.id}_20min`, `@everyone ⚠️ **${b.name}** spawn window closes in 20 minutes!`);
    }
    if (TRACKED_BOSS_TYPES.has(b.type) && timeSinceWindowExpired >= 10 * 60 * 1000 && !w.missedHandled) {
      w.missedHandled = true;
      handleMissedWindow(b, b.id, channel);
    }
  }
}

// =====================
// WARNING SYSTEM — Shadow Abyss
// =====================
function checkSAWarnings(channel) {
  const now = Date.now();
  if (now - BOT_START_TIME < STARTUP_GRACE_MS) return;
  for (const b of SHADOW_BOSSES) {
    const e = data.kills[b.id];
    if (!e) continue;
    const isGoblin               = b.type === "goblin";
    const cooldown               = e.respawnTime - now;
    const windowEnd              = isGoblin ? e.respawnTime + SA_GOBLIN_WINDOW_MS : e.respawnTime + 5 * 60 * 1000;
    const windowLeft             = windowEnd - now;
    const timeSinceWindowExpired = now - windowEnd;
    const advCount               = missedCount[b.id] || 0;
    if (!spawnWarnings[b.id])
      spawnWarnings[b.id] = { warned5: false, warned20: false, windowCreated: false, missedHandled: false };
    const w = spawnWarnings[b.id];

    // 5-min warning
    if (cooldown > 0 && cooldown <= 5 * 60 * 1000 && !w.warned5) {
      w.warned5 = true;
      if (!missedWindowMessages[b.id]) {
        const qtyStr = GOBLIN_QTY[b.key] ? ` (x${GOBLIN_QTY[b.key]})` : "";
        postEveryoneWarning(channel, `${b.id}_5min`,
          `@everyone ⏳ **[Shadow Abyss] ${b.name}${qtyStr}** spawns in 5 minutes`, Math.max(cooldown, 0));
      }
    }

    // Goblin window open
    if (isGoblin && cooldown <= 0 && windowLeft > 0 && !w.windowCreated) {
      w.windowCreated = true;
      clearEveryoneWarning(`${b.id}_5min`);
      if (!missedWindowMessages[b.id]) createSASpawnWindow(b, b.id, channel, windowEnd);
    }

    // Goblin 20-min warning
    if (isGoblin && cooldown <= 0 && windowLeft > 0 && windowLeft <= 20 * 60 * 1000 && !w.warned20) {
      w.warned20 = true;
      postEveryoneWarning(channel, `${b.id}_20min`,
        `@everyone ⚠️ **[Shadow Abyss] ${b.name}** goblin window closes in 20 minutes!`);
    }

    // Fixed boss — notify at spawn time
    if (!isGoblin && cooldown <= 0 && cooldown >= -5 * 60 * 1000 && !w.windowCreated) {
      w.windowCreated = true;
      clearEveryoneWarning(`${b.id}_5min`);
      const tsRespawn = Math.floor(e.respawnTime / 1000);
      postEveryoneWarning(channel, `${b.id}_spawned`,
        `@everyone 🌑 **[Shadow Abyss] ${b.name}** has spawned! Log the kill when done.\n<t:${tsRespawn}:t>`,
        10 * 60 * 1000);
    }

    // Missed window
    if (timeSinceWindowExpired >= 10 * 60 * 1000 && !w.missedHandled) {
      w.missedHandled = true;
      if (isGoblin && advCount < SA_MAX_AUTO_ADVANCE) {
        handleSAMissedWindowGoblin(b, b.id, channel);
      } else if (!isGoblin) {
        handleSAMissedWindowFixed(b, b.id, channel);
      }
      // Locked goblins: missedHandled already set to true above, nothing more to do
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
      if (timeUntil > warnMs + 60 * 1000 || timeUntil < -TICK_RATE) continue;
      const eventDate = new Date(eventMs).toLocaleDateString("en-CA", { timeZone: SERVER_TZ });
      const key       = `${ev.name}|${hhmm}|${eventDate}`;
      if (eventPingedKeys.has(key)) continue;
      eventPingedKeys.add(key);
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
        const yesterday = new Date(now - 25 * 60 * 60 * 1000).toLocaleDateString("en-CA", { timeZone: SERVER_TZ });
        for (const k of eventPingedKeys) { if (k.endsWith(`|${yesterday}`)) eventPingedKeys.delete(k); }
      }
    }
  }
}

// =====================
// CLEANUP HELPERS
// =====================
function clearBossCards(id, resetMissed = true) {
  if (resetMissed) missedCount[id] = 0;
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
  clearEveryoneWarning(`${id}_stale_timer`);
}

function clearSABossCards(id, resetMissed = true) {
  if (resetMissed) missedCount[id] = 0;
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
  clearEveryoneWarning(`${id}_spawned`);
  clearEveryoneWarning(`${id}_sa_missed_start`);
  clearEveryoneWarning(`${id}_sa_missed_20min`);
  clearEveryoneWarning(`${id}_sa_locked`);
  for (let i = 1; i <= SA_MAX_AUTO_ADVANCE; i++) clearEveryoneWarning(`${id}_sa_stale_${i}`);
  for (let i = 1; i <= 10; i++) clearEveryoneWarning(`${id}_sa_fixed_missed_${i}`);
}

// =====================
// READY
// =====================
client.once(Events.ClientReady, async () => {
  console.log("Bot online");
  load();
  if (await recoverFromDiscordBackup()) console.log("[Recovery] Timers restored.");
  restoreSpawnWarningFlags();
  const channel = await client.channels.fetch(CHANNEL_ID);
  await initLogMessage(channel);
  try { await initBackupMessage(await client.channels.fetch(LOG_CHANNEL_ID)); }
  catch (err) { console.error("[Backup] Could not init:", err.message ?? err); }
  dashboardMessage = await channel.send({
    embeds: [buildEmbed()], components: buildButtons(), flags: MessageFlags.SuppressNotifications
  });
  shadowDashMessage = await channel.send({
    embeds: [buildShadowEmbed()], components: buildShadowButtons(), flags: MessageFlags.SuppressNotifications
  });
  startLoop();
  startBackupLoop();
  setTimeout(() => runBackup().catch(err => console.error("[Backup] Startup failed:", err.message ?? err)), 5000);
});

// =====================
// INTERACTIONS
// =====================
client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isButton() && !interaction.isStringSelectMenu() && !interaction.isModalSubmit()) return;

  if (Date.now() - lastBackupRepost > BACKUP_REPOST_COOLDOWN_MS) {
    lastBackupRepost = Date.now();
    repostBackupToBottom();
  }

  // ── ORIGINAL: KILL BUTTON ──
  if (interaction.isButton() && interaction.customId.startsWith("kill_")) {
    snapshot();
    const id   = interaction.customId.replace("kill_", "");
    const boss = BOSSES.find(b => b.id === id);
    const now  = Date.now();
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

  // ── ORIGINAL: WINDOW KILL ──
  if (interaction.isButton() && interaction.customId.startsWith("window_kill_")) {
    snapshot();
    const id   = interaction.customId.replace("window_kill_", "");
    const boss = BOSSES.find(b => b.id === id);
    const now  = Date.now();
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

  // ── ORIGINAL: WINDOW SET TIME — show modal ──
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

  // ── ORIGINAL: WINDOW SET TIME — modal submit ──
  if (interaction.isModalSubmit() && interaction.customId.startsWith("window_killtime_")) {
    snapshot();
    const id   = interaction.customId.replace("window_killtime_", "");
    const boss = BOSSES.find(b => b.id === id);
    const [h, m] = interaction.fields.getTextInputValue("time").split(":").map(Number);
    const kill = parseServerTime(h, m);
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

  // ── ORIGINAL: MISSED KILL ──
  if (interaction.isButton() && interaction.customId.startsWith("missed_kill_")) {
    snapshot();
    const id   = interaction.customId.replace("missed_kill_", "");
    const boss = BOSSES.find(b => b.id === id);
    const now  = Date.now();
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

  // ── ORIGINAL: MISSED SET TIME — show modal ──
  if (interaction.isButton() && interaction.customId.startsWith("missed_settime_")) {
    const id   = interaction.customId.replace("missed_settime_", "");
    const boss = BOSSES.find(b => b.id === id);
    log(interaction.user, `Opened set-time modal for ${boss.name} (missed window)`);
    const modal = new ModalBuilder().setCustomId("missed_killtime_" + id).setTitle(`Set Kill Time — ${boss.name}`);
    modal.addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId("time").setLabel("HH:MM (24h, server time)").setStyle(TextInputStyle.Short)
    ));
    return interaction.showModal(modal);
  }

  // ── ORIGINAL: MISSED SET TIME — modal submit ──
  if (interaction.isModalSubmit() && interaction.customId.startsWith("missed_killtime_")) {
    snapshot();
    const id   = interaction.customId.replace("missed_killtime_", "");
    const boss = BOSSES.find(b => b.id === id);
    const [h, m] = interaction.fields.getTextInputValue("time").split(":").map(Number);
    const kill = parseServerTime(h, m);
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

  // ── ORIGINAL: INSERT TIME — boss picker ──
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

  // ── ORIGINAL: INSERT TIME — modal trigger ──
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

  // ── ORIGINAL: INSERT TIME — modal submit ──
  if (interaction.isModalSubmit() && interaction.customId.startsWith("killtime_server_")) {
    snapshot();
    const id   = interaction.customId.replace("killtime_server_", "");
    const boss = BOSSES.find(b => b.id === id);
    const [h, m] = interaction.fields.getTextInputValue("time").split(":").map(Number);
    const kill = parseServerTime(h, m);
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

  // ── ORIGINAL: RESET — picker ──
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

  // ── ORIGINAL: RESET — apply ──
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

  // ── ORIGINAL: UNDO ──
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
    return interaction.reply({ embeds: [buildLogEmbed()], flags: MessageFlags.Ephemeral });
  }

  // ═══════════════════════════════════════════════
  // SHADOW ABYSS INTERACTIONS
  // ═══════════════════════════════════════════════

  // ── SA: KILL TYPE BUTTON — pick server ──
  if (interaction.isButton() && interaction.customId.startsWith("sa_kill_type_")) {
    const key   = interaction.customId.replace("sa_kill_type_", "");
    const label = SHADOW_BOSSES.find(b => b.key === key)?.label ?? key;
    log(interaction.user, `SA: Opened server select for ${label}`);
    const menu = new StringSelectMenuBuilder()
      .setCustomId(`sa_server_select_${key}`)
      .setPlaceholder("Select server")
      .addOptions(SA_SERVERS.map(s => ({ label: `Server ${s}`, value: String(s) })));
    return interaction.reply({
      content: `⚔️ **${label}** — Select the server where the kill happened:`,
      components: [new ActionRowBuilder().addComponents(menu)],
      flags: MessageFlags.Ephemeral
    });
  }

  // ── SA: SERVER SELECTED — show modal ──
  if (interaction.isStringSelectMenu() && interaction.customId.startsWith("sa_server_select_")) {
    const key    = interaction.customId.replace("sa_server_select_", "");
    const server = interaction.values[0];
    const id     = `sa_${key}_s${server}`;
    const boss   = SHADOW_BOSSES.find(b => b.id === id);
    log(interaction.user, `SA: Selected server ${server} for ${boss.name}`);
    const modal = new ModalBuilder()
      .setCustomId(`sa_killtime_${id}`)
      .setTitle(`Kill Time — ${boss.name}`);
    modal.addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId("time")
        .setLabel("HH:MM (24h, server time) or 'now'")
        .setStyle(TextInputStyle.Short)
        .setPlaceholder("e.g. 21:34 or now")
    ));
    return interaction.showModal(modal);
  }

  // ── SA: KILL TIME MODAL SUBMIT ──
  if (interaction.isModalSubmit() && interaction.customId.startsWith("sa_killtime_")) {
    snapshot();
    const id   = interaction.customId.replace("sa_killtime_", "");
    const boss = SHADOW_BOSSES.find(b => b.id === id);
    const raw  = interaction.fields.getTextInputValue("time").trim().toLowerCase();
    const now  = Date.now();
    let killTime;
    if (raw === "now") { killTime = now; }
    else { const [h, m] = raw.split(":").map(Number); killTime = parseServerTime(h, m).getTime(); }
    const respawnMs   = SA_RESPAWN_H[boss.type] * 60 * 60 * 1000;
    const respawnTime = killTime + respawnMs;
    data.kills[id] = { killTime, respawnTime, lastKiller: interaction.user.username };
    save();
    log(interaction.user, `SA KILL ${boss.name} — kill: ${toServerDateTimeStr(killTime)} — respawn: ${toServerDateTimeStr(respawnTime)}`);
    spawnWarnings[id] = { warned5: false, warned20: false, windowCreated: false, missedHandled: false };
    clearSABossCards(id);
    await announceKill(interaction.channel, interaction.user, `killed **[Shadow Abyss] ${boss.name}**`,
      `🕒 Kill: ${toServerDateTimeStr(killTime)} — 🔄 Respawn: ${toServerDateTimeStr(respawnTime)}`);
    return interaction.deferUpdate();
  }

  // ── SA: WINDOW KILL ──
  if (interaction.isButton() && interaction.customId.startsWith("sa_window_kill_")) {
    snapshot();
    const id   = interaction.customId.replace("sa_window_kill_", "");
    const boss = SHADOW_BOSSES.find(b => b.id === id);
    const now  = Date.now();
    const respawnMs   = SA_RESPAWN_H[boss.type] * 60 * 60 * 1000;
    const respawnTime = now + respawnMs;
    clearSABossCards(id);
    data.kills[id] = { killTime: now, respawnTime, lastKiller: interaction.user.username };
    save();
    log(interaction.user, `SA WINDOW KILL ${boss.name} — kill: ${toServerDateTimeStr(now)} — respawn: ${toServerDateTimeStr(respawnTime)}`);
    spawnWarnings[id] = { warned5: false, warned20: false, windowCreated: false, missedHandled: false };
    await announceKill(interaction.channel, interaction.user, `killed **[Shadow Abyss] ${boss.name}** (window kill)`,
      `🕒 Kill: ${toServerDateTimeStr(now)} — 🔄 Respawn: ${toServerDateTimeStr(respawnTime)}`);
    return interaction.deferUpdate();
  }

  // ── SA: WINDOW SET TIME — show modal ──
  if (interaction.isButton() && interaction.customId.startsWith("sa_window_settime_")) {
    const id   = interaction.customId.replace("sa_window_settime_", "");
    const boss = SHADOW_BOSSES.find(b => b.id === id);
    log(interaction.user, `SA: Opened set-time modal for ${boss.name} (window)`);
    const modal = new ModalBuilder().setCustomId(`sa_window_killtime_${id}`).setTitle(`Set Kill Time — ${boss.name}`);
    modal.addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId("time").setLabel("HH:MM (24h, server time) or 'now'").setStyle(TextInputStyle.Short).setPlaceholder("e.g. 21:34 or now")
    ));
    return interaction.showModal(modal);
  }

  // ── SA: WINDOW SET TIME — modal submit ──
  if (interaction.isModalSubmit() && interaction.customId.startsWith("sa_window_killtime_")) {
    snapshot();
    const id   = interaction.customId.replace("sa_window_killtime_", "");
    const boss = SHADOW_BOSSES.find(b => b.id === id);
    const raw  = interaction.fields.getTextInputValue("time").trim().toLowerCase();
    const now  = Date.now();
    let killTime;
    if (raw === "now") { killTime = now; }
    else { const [h, m] = raw.split(":").map(Number); killTime = parseServerTime(h, m).getTime(); }
    const respawnMs   = SA_RESPAWN_H[boss.type] * 60 * 60 * 1000;
    const respawnTime = killTime + respawnMs;
    clearSABossCards(id);
    data.kills[id] = { killTime, respawnTime, lastKiller: interaction.user.username };
    save();
    log(interaction.user, `SA MANUAL SET (window) ${boss.name} — kill: ${toServerDateTimeStr(killTime)} — respawn: ${toServerDateTimeStr(respawnTime)}`);
    spawnWarnings[id] = { warned5: false, warned20: false, windowCreated: false, missedHandled: false };
    await announceKill(interaction.channel, interaction.user, `manually set **[Shadow Abyss] ${boss.name}** kill time (from window)`,
      `🕒 Kill: ${toServerDateTimeStr(killTime)} — 🔄 Respawn: ${toServerDateTimeStr(respawnTime)}`);
    return interaction.deferUpdate();
  }

  // ── SA: MISSED KILL ──
  if (interaction.isButton() && interaction.customId.startsWith("sa_missed_kill_")) {
    snapshot();
    const id   = interaction.customId.replace("sa_missed_kill_", "");
    const boss = SHADOW_BOSSES.find(b => b.id === id);
    const now  = Date.now();
    const respawnMs   = SA_RESPAWN_H[boss.type] * 60 * 60 * 1000;
    const respawnTime = now + respawnMs;
    clearSABossCards(id);
    data.kills[id] = { killTime: now, respawnTime, lastKiller: interaction.user.username };
    save();
    log(interaction.user, `SA MISSED-WINDOW KILL ${boss.name} — kill: ${toServerDateTimeStr(now)} — respawn: ${toServerDateTimeStr(respawnTime)}`);
    spawnWarnings[id] = { warned5: false, warned20: false, windowCreated: false, missedHandled: false };
    await announceKill(interaction.channel, interaction.user, `killed **[Shadow Abyss] ${boss.name}** (missed-window kill)`,
      `🕒 Kill: ${toServerDateTimeStr(now)} — 🔄 Respawn: ${toServerDateTimeStr(respawnTime)}`);
    return interaction.deferUpdate();
  }

  // ── SA: MISSED SET TIME — show modal ──
  if (interaction.isButton() && interaction.customId.startsWith("sa_missed_settime_")) {
    const id   = interaction.customId.replace("sa_missed_settime_", "");
    const boss = SHADOW_BOSSES.find(b => b.id === id);
    log(interaction.user, `SA: Opened set-time modal for ${boss.name} (missed window)`);
    const modal = new ModalBuilder().setCustomId(`sa_missed_killtime_${id}`).setTitle(`Set Kill Time — ${boss.name}`);
    modal.addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId("time").setLabel("HH:MM (24h, server time) or 'now'").setStyle(TextInputStyle.Short).setPlaceholder("e.g. 21:34 or now")
    ));
    return interaction.showModal(modal);
  }

  // ── SA: MISSED SET TIME — modal submit ──
  if (interaction.isModalSubmit() && interaction.customId.startsWith("sa_missed_killtime_")) {
    snapshot();
    const id   = interaction.customId.replace("sa_missed_killtime_", "");
    const boss = SHADOW_BOSSES.find(b => b.id === id);
    const raw  = interaction.fields.getTextInputValue("time").trim().toLowerCase();
    const now  = Date.now();
    let killTime;
    if (raw === "now") { killTime = now; }
    else { const [h, m] = raw.split(":").map(Number); killTime = parseServerTime(h, m).getTime(); }
    const respawnMs   = SA_RESPAWN_H[boss.type] * 60 * 60 * 1000;
    const respawnTime = killTime + respawnMs;
    clearSABossCards(id);
    data.kills[id] = { killTime, respawnTime, lastKiller: interaction.user.username };
    save();
    log(interaction.user, `SA MANUAL SET (missed-window) ${boss.name} — kill: ${toServerDateTimeStr(killTime)} — respawn: ${toServerDateTimeStr(respawnTime)}`);
    spawnWarnings[id] = { warned5: false, warned20: false, windowCreated: false, missedHandled: false };
    await announceKill(interaction.channel, interaction.user, `manually set **[Shadow Abyss] ${boss.name}** kill time (from missed-window)`,
      `🕒 Kill: ${toServerDateTimeStr(killTime)} — 🔄 Respawn: ${toServerDateTimeStr(respawnTime)}`);
    return interaction.deferUpdate();
  }

  // ── SA: INSERT TIME — mob type picker ──
  if (interaction.isButton() && interaction.customId === "sa_insert_time") {
    log(interaction.user, `SA: Opened insert — mob type selection`);
    const keys = [...new Set(SHADOW_BOSSES.map(b => b.key))];
    const menu = new StringSelectMenuBuilder()
      .setCustomId("sa_insert_type_select")
      .setPlaceholder("Select mob type")
      .addOptions(keys.map(k => {
        const b = SHADOW_BOSSES.find(x => x.key === k);
        return { label: b.label, value: k };
      }));
    return interaction.reply({
      content: "📝 **Shadow Abyss** — Select mob type:",
      components: [new ActionRowBuilder().addComponents(menu)],
      flags: MessageFlags.Ephemeral
    });
  }

  // ── SA: INSERT TIME — server picker ──
  if (interaction.isStringSelectMenu() && interaction.customId === "sa_insert_type_select") {
    const key   = interaction.values[0];
    const label = SHADOW_BOSSES.find(b => b.key === key)?.label ?? key;
    const menu  = new StringSelectMenuBuilder()
      .setCustomId(`sa_insert_server_select_${key}`)
      .setPlaceholder("Select server")
      .addOptions(SA_SERVERS.map(s => ({ label: `Server ${s}`, value: String(s) })));
    return interaction.reply({
      content: `📝 **${label}** — Select server:`,
      components: [new ActionRowBuilder().addComponents(menu)],
      flags: MessageFlags.Ephemeral
    });
  }

  // ── SA: INSERT TIME — modal trigger ──
  if (interaction.isStringSelectMenu() && interaction.customId.startsWith("sa_insert_server_select_")) {
    const key    = interaction.customId.replace("sa_insert_server_select_", "");
    const server = interaction.values[0];
    const id     = `sa_${key}_s${server}`;
    const boss   = SHADOW_BOSSES.find(b => b.id === id);
    log(interaction.user, `SA Insert: selected ${boss.name}`);
    const modal = new ModalBuilder().setCustomId(`sa_killtime_${id}`).setTitle(`Insert Kill Time — ${boss.name}`);
    modal.addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId("time").setLabel("HH:MM (24h, server time) or 'now'").setStyle(TextInputStyle.Short).setPlaceholder("e.g. 21:34 or now")
    ));
    return interaction.showModal(modal);
  }

  // ── SA: RESET — picker ──
  if (interaction.isButton() && interaction.customId === "sa_reset") {
    log(interaction.user, `SA: Opened reset menu`);
    const menu = new StringSelectMenuBuilder()
      .setCustomId("sa_reset_select")
      .setPlaceholder("Select what to reset")
      .addOptions([
        ...SHADOW_BOSSES.map(b => ({ label: `Reset ${b.name}`, value: b.id })),
        { label: "☠️ DELETE ALL SA TIMERS", value: "SA_DELETE_ALL" }
      ]);
    return interaction.reply({
      content: "🧹 **Shadow Abyss** — What do you want to reset?",
      components: [new ActionRowBuilder().addComponents(menu)],
      flags: MessageFlags.Ephemeral
    });
  }

  // ── SA: RESET — apply ──
  if (interaction.isStringSelectMenu() && interaction.customId === "sa_reset_select") {
    snapshot();
    const value = interaction.values[0];
    if (value === "SA_DELETE_ALL") {
      for (const b of SHADOW_BOSSES) {
        clearSABossCards(b.id);
        delete data.kills[b.id];
        spawnWarnings[b.id] = { warned5: false, warned20: false, windowCreated: false, missedHandled: false };
      }
      save();
      log(interaction.user, `SA RESET ALL TIMERS`);
      await announceAdmin(interaction.channel, interaction.user, "reset **ALL Shadow Abyss** timers ☠️");
      return interaction.deferUpdate();
    }
    const boss = SHADOW_BOSSES.find(b => b.id === value);
    clearSABossCards(value);
    delete data.kills[value];
    spawnWarnings[value] = { warned5: false, warned20: false, windowCreated: false, missedHandled: false };
    save();
    log(interaction.user, `SA RESET timer for ${boss.name}`);
    await announceAdmin(interaction.channel, interaction.user, `reset timer for **[Shadow Abyss] ${boss.name}**`);
    return interaction.deferUpdate();
  }

  // ── SA: UNDO ──
  if (interaction.isButton() && interaction.customId === "sa_undo") {
    if (undo()) {
      log(interaction.user, `SA UNDO`);
      for (const id of Object.keys(spawnWarnings))
        spawnWarnings[id] = { warned5: false, warned20: false, windowCreated: false, missedHandled: false };
      await announceAdmin(interaction.channel, interaction.user, "used **undo** (Shadow Abyss)");
    }
    return interaction.deferUpdate();
  }
});

client.login(TOKEN);
