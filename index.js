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

const EVERYONE_WARNING_LIFESPAN_MS    = 10 * 60 * 1000;
const EVERYONE_REPIN_BEFORE_EXPIRE_MS =  1 * 60 * 1000;
const WINDOW_GRACE_MS                 = 15 * 60 * 1000;

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

let backupMessage = null;
let logMessage    = null;

let missedCount      = {}; // tracks auto-advance count per boss id
let repinInProgress  = false;
let lastBackupRepost = 0;
const BACKUP_REPOST_COOLDOWN_MS = 60 * 1000;

const BOT_START_TIME   = Date.now();
const STARTUP_GRACE_MS = 30 * 1000;

// =====================
// BOSSES
// =====================
function buildBosses() {
  const bosses = [];

  // Original bosses
  for (let i = 1; i <= 3; i++) bosses.push({ id: `lorencia_${i}`, name: `Kharzul #${i}`,         type: "kharzul" });
  for (let i = 1; i <= 3; i++) bosses.push({ id: `davias_${i}`,   name: `Vescrya #${i}`,          type: "vescrya" });
  for (let i = 1; i <= 2; i++) bosses.push({ id: `crywolf_${i}`,  name: `Muggron #${i} Crywolf`,  type: "muggron" });
  for (let i = 1; i <= 2; i++) bosses.push({ id: `barracks_${i}`, name: `Muggron #${i} Barracks`, type: "muggron" });

  // Cryonox — Twisted Karutan: 4 per server, 3 servers
  for (let s = 1; s <= 3; s++) {
    for (let i = 1; i <= 4; i++) {
      bosses.push({
        id:       `cryonox_karutan_s${s}_${i}`,
        name:     `Cryonox #${i} Karutan S${s}`,
        type:     "cryonox",
        location: "Twisted Karutan",
        server:   s,
        slot:     i,
      });
    }
  }

  // Cryonox — Land of Trials: 2
  for (let i = 1; i <= 2; i++) {
    bosses.push({
      id:       `cryonox_trials_${i}`,
      name:     `Cryonox #${i} Trials`,
      type:     "cryonox",
      location: "Land of Trials",
      server:   null,
      slot:     i,
    });
  }

  return bosses;
}
const BOSSES = buildBosses();

// Boss-type configuration overrides
// respawnMs:       cooldown from kill until the spawn WINDOW OPENS (stored as respawnTime)
// respawnWindowMs: how long the spawn window stays open after respawnTime
// missedAdvanceMs: how much to shift respawnTime forward on a missed window
// maxMissed:       max auto-advance cycles before stopping
//
// Default (Kharzul/Vescrya/Muggron): kill → 7h cooldown → window opens → 1h window
// Cryonox:                           kill → 5h cooldown → window opens → 2h window
const BOSS_TYPE_CONFIG = {
  default: {
    respawnMs:       7 * 60 * 60 * 1000,
    respawnWindowMs: 60 * 60 * 1000,
    missedAdvanceMs: 7 * 60 * 60 * 1000,
    maxMissed:       Infinity,
  },
  cryonox: {
    respawnMs:       5 * 60 * 60 * 1000, // 5h cooldown → window opens
    respawnWindowMs: 2 * 60 * 60 * 1000, // 2h window
    missedAdvanceMs: 1 * 60 * 60 * 1000, // shift window +1h per miss
    maxMissed:       2,
  },
};

function bossConfig(boss) {
  return BOSS_TYPE_CONFIG[boss.type] ?? BOSS_TYPE_CONFIG.default;
}

const TRACKED_BOSS_TYPES = new Set(["kharzul", "vescrya", "cryonox"]);

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

  // ── Fixed-Respawn World Bosses ──
  {
    name: "👹 Abaddon",
    times: ["03:50","17:50"],
    warnMinutes: 5,
    extraNote: "📍 Location: **Twisted Karutan** | 🎁 Drop: Armor Sets, Weapons",
  },
  {
    name: "💀 Lord Kundun",
    times: ["01:50","15:50"],
    warnMinutes: 5,
    extraNote: "📍 Location: **Shadow Abyss** | 🎁 Drop: Weapons",
  },
  {
    name: "🔥 Infernal Overlord",
    times: ["04:50","20:50"],
    warnMinutes: 5,
    extraNote: "📍 Location: **Kanturu Labyrinth** | 🎁 Drop: Armor Sets",
  },
  {
    name: "🪽 Aurindra",
    times: ["23:50"],
    warnMinutes: 5,
    extraNote: "📍 Location: **Crimson Icarus** | 🎁 Drop: Wing 2, Phoenix Feather, Wing 2.5",
  },

  // ── Frigidons — fixed every 3h starting 00:00, 3 monsters in Ruined Devias ──
  {
    name: "❄️ Frigidons",
    times: ["00:00","03:00","06:00","09:00","12:00","15:00","18:00","21:00"],
    warnMinutes: 5,
    extraNote: "📍 Location: **Ruined Devias** | 3 monsters spawn simultaneously",
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
// RESTORE WARNING FLAGS ON STARTUP
// Pre-sets all warning flags so a restart never re-fires @everyone pings
// that already went out in a previous session.
// =====================
function restoreSpawnWarningFlags() {
  const now = Date.now();

  for (const b of BOSSES) {
    const cfg = bossConfig(b);
    const e   = data.kills[b.id];
    if (!e) {
      spawnWarnings[b.id] = { warned5: false, warned20: false, windowCreated: false, missedHandled: false };
      continue;
    }

    const cooldown      = e.respawnTime - now;
    const windowEnd     = e.respawnTime + cfg.respawnWindowMs;
    const windowExpired = now > windowEnd;

    spawnWarnings[b.id] = {
      warned5:       cooldown <= 5 * 60 * 1000,
      warned20:      cooldown <= 0 && (windowEnd - now) <= 20 * 60 * 1000,
      windowCreated: cooldown <= 0,
      missedHandled: windowExpired,
    };

    if (windowExpired && TRACKED_BOSS_TYPES.has(b.type)) {
      const nextWindowStart = e.respawnTime;
      const nextWindowEnd   = e.respawnTime + cfg.respawnWindowMs * 2; // missed window is double
      const untilEnd        = nextWindowEnd - now;

      if (untilEnd + WINDOW_GRACE_MS > 0) {
        missedWindowMessages[b.id] = {
          msg:            null,
          deleteTimer:    null,
          nextWindowStart,
          nextWindowEnd,
          boss:           b,
          pingedStart:    nextWindowStart <= now,
          pinged1h:       untilEnd <= 60 * 60 * 1000,
          pinged20min:    untilEnd <= 20 * 60 * 1000,
        };
        console.log(`[Startup] Restored missed window state for ${b.name}`);
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
// SPAWN WINDOW EMBEDS & COMPONENTS
// =====================
function buildSpawnWindowEmbed(boss, windowStart, windowEnd) {
  const remaining = windowEnd - Date.now();
  const tsStart   = Math.floor(windowStart / 1000);
  const tsEnd     = Math.floor(windowEnd / 1000);
  const cfg       = bossConfig(boss);
  const windowLabel = cfg.respawnWindowMs >= 2 * 60 * 60 * 1000 ? "2h window" : "1h window";
  const desc = remaining > 0
    ? `⏳ Time left: **${formatSeconds(remaining)}** (${windowLabel})\n🟢 Opened: ${toServerTimeStr(windowStart)} (server) — <t:${tsStart}:t> (your time)\n🔴 Closes: ${toServerTimeStr(windowEnd)} (server) — <t:${tsEnd}:t> (your time)`
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
  const cfg        = bossConfig(boss);
  const maxMissed  = cfg.maxMissed === Infinity ? "" : ` (max ${cfg.maxMissed})`;

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
      `> The previous window passed without a kill being logged.${maxMissed}`
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

  // Group Cryonox separately for cleaner display
  const regularBosses = BOSSES.filter(b => b.type !== "cryonox");
  const cryonoxBosses = BOSSES.filter(b => b.type === "cryonox");

  const renderBoss = (b) => {
    const cfg = bossConfig(b);
    const e   = data.kills[b.id];
    if (!e) return { name: b.name, timeLeft: 0, text: `🟢 READY\n👤 None`, isBroken: false };

    const cooldown      = e.respawnTime - now;
    const windowEnd     = e.respawnTime + cfg.respawnWindowMs;
    const windowLeft    = windowEnd - now;
    const isMissed      = !!missedWindowMessages[b.id];
    const missedTimes   = missedCount[b.id] || 0;
    const atMaxMissed   = cfg.maxMissed !== Infinity && missedTimes >= cfg.maxMissed;
    const missedLabel   = atMaxMissed
      ? `🚫 Max missed windows reached (${missedTimes}x) — update manually!`
      : missedTimes >= 2
        ? `⚠️ Timer wrong (${missedTimes}x missed) — update manually!`
        : `⚠️ Timer possibly wrong (1st miss)`;
    let text, isBroken  = false;

    if (cooldown > 0) {
      const tsRespawn = Math.floor(e.respawnTime / 1000);
      if (isMissed) {
        const missedNote = atMaxMissed
          ? `🚫 Max missed windows reached — needs manual update!`
          : missedTimes >= 2
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
      const winLabel  = cfg.respawnWindowMs >= 2 * 60 * 60 * 1000 ? "2h WINDOW" : "WINDOW";
      text = `🟢 ${winLabel} — ⏳ ${format(windowLeft)}\n🕒 Was due: ${toServerTimeStr(e.respawnTime)} (server) — <t:${tsRespawn}:t> (your time)\n👤 ${e.lastKiller}`;
    } else {
      const nextWindowOpen  = e.respawnTime + cfg.respawnWindowMs;
      const nextWindowClose = e.respawnTime + cfg.respawnWindowMs * 2;
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
  };

  // Sort and add regular bosses
  const regularRendered = regularBosses.map(renderBoss);
  regularRendered.sort((a, b) => {
    if (a.isBroken && !b.isBroken) return 1;
    if (!a.isBroken && b.isBroken) return -1;
    return a.timeLeft - b.timeLeft;
  });
  for (const b of regularRendered) embed.addFields({ name: `• ${b.name}`, value: b.text });

  // Add Cryonox bosses — all rendered under one section header (no sub-headers to stay under 25 field limit)
  if (cryonoxBosses.length > 0) {
    embed.addFields({ name: "━━━━━━━━━━━━━━━━━━━━━━━━", value: "❄️ **CRYONOX** (5h cooldown + 2h window)" });

    // Render all Cryonox; location/server already in boss.name (e.g. "Cryonox #1 Karutan S2")
    const allCryRendered = cryonoxBosses.map(renderBoss);
    allCryRendered.sort((a, b_) => {
      if (a.isBroken && !b_.isBroken) return 1;
      if (!a.isBroken && b_.isBroken) return -1;
      return a.timeLeft - b_.timeLeft;
    });
    for (const b of allCryRendered) embed.addFields({ name: `• ${b.name}`, value: b.text });
  }

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

  // Original bosses only (Kharzul, Vescrya, Muggron)
  const regularBosses = BOSSES.filter(b => b.type !== "cryonox");
  for (const group of chunk(regularBosses, 5)) {
    const row = new ActionRowBuilder();
    for (const b of group)
      row.addComponents(new ButtonBuilder().setCustomId("kill_" + b.id).setLabel(b.name.slice(0, 20)).setStyle(ButtonStyle.Primary));
    rows.push(row);
  }

  // Cryonox button — opens a server+slot selection flow
  // Limit to 5 rows total for Discord. We add Cryonox to the last admin row or a new row.
  rows.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("cryonox_pick").setLabel("❄️ Cryonox").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("insert_time").setLabel("📝 Insert").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("reset_all").setLabel("🧹 Reset").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("undo").setLabel("↩️ Undo").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("show_logs").setLabel("📜 Logs").setStyle(ButtonStyle.Secondary)
  ));

  // Discord maximum is 5 action rows — trim if needed
  return rows.slice(0, 5);
}

// =====================
// REPIN DASHBOARD
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

    for (const id of Object.keys(spawnWindowMessages)) {
      const w = spawnWindowMessages[id];
      if (w.msg) w.msg.delete().catch(() => {});
      if (w.windowEnd + WINDOW_GRACE_MS > now) {
        w.msg = await channel.send({
          embeds: [buildSpawnWindowEmbed(w.boss, w.windowStart, w.windowEnd)],
          components: buildSpawnWindowComponents(id), flags: MessageFlags.SuppressNotifications
        }).catch(() => null);
      } else { delete spawnWindowMessages[id]; }
    }

    for (const id of Object.keys(missedWindowMessages)) {
      const w = missedWindowMessages[id];
      if (w.nextWindowStart > now) { if (w.msg) { w.msg.delete().catch(() => {}); w.msg = null; } continue; }
      if (w.nextWindowEnd + WINDOW_GRACE_MS <= now) { if (w.msg) w.msg.delete().catch(() => {}); delete missedWindowMessages[id]; continue; }
      if (w.msg) w.msg.delete().catch(() => {});
      w.msg = await channel.send({
        embeds: [buildMissedWindowEmbed(w.boss, w.nextWindowStart, w.nextWindowEnd)],
        components: buildMissedWindowComponents(id), flags: MessageFlags.SuppressNotifications
      }).catch(() => null);
    }

    console.log("[Repin] Dashboard stack refreshed.");
  } finally { repinInProgress = false; }
}

// =====================
// SPAWN WINDOW CREATION
// =====================
async function createSpawnWindow(boss, id, channel, windowEnd) {
  if (spawnWindowMessages[id]) return;
  const cfg         = bossConfig(boss);
  const windowStart = windowEnd - cfg.respawnWindowMs;
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
// MISSED WINDOW / AUTO-ADVANCE
// =====================
async function handleMissedWindow(boss, id, channel) {
  const e   = data.kills[id];
  const cfg = bossConfig(boss);
  if (!e) return;

  // Check if we've reached the max missed windows for this boss type
  const currentCount = missedCount[id] || 0;
  if (cfg.maxMissed !== Infinity && currentCount >= cfg.maxMissed) {
    console.log(`[MissedWindow] ${boss.name} has reached max missed windows (${cfg.maxMissed}) — no more auto-advance.`);
    // Post a final alert if not already one active
    const key = `${id}_stale_timer`;
    if (!everyoneWarnings[key]) {
      const tsRespawn = Math.floor(e.respawnTime / 1000);
      const content =
        `@everyone 🚫 **${boss.name}** has reached the maximum missed windows (${cfg.maxMissed}x)!\n` +
        `The timer cannot be auto-corrected further — please find and log the boss manually.\n` +
        `📍 Last estimated respawn: ${toServerTimeStr(e.respawnTime)} (server) — <t:${tsRespawn}:t> (your time)`;
      postEveryoneWarning(channel, key, content, 30 * 60 * 1000);
    }
    return;
  }

  // Increment missed count
  missedCount[id] = currentCount + 1;
  const count     = missedCount[id];

  console.log(`[MissedWindow] No kill for ${boss.name} — auto-advancing ${format(cfg.missedAdvanceMs)} (advance #${count})`);
  snapshot();
  e.respawnTime = e.respawnTime + cfg.missedAdvanceMs;
  e.killTime    = e.respawnTime - cfg.missedAdvanceMs;
  save();
  spawnWarnings[id] = { warned5: false, warned20: false, windowCreated: false, missedHandled: false };
  clearBossCards(id);

  const nextWindowStart = e.respawnTime;
  const nextWindowEnd   = e.respawnTime + cfg.respawnWindowMs; // next missed window uses normal respawnWindowMs
  missedWindowMessages[id] = {
    msg: null, deleteTimer: null,
    nextWindowStart, nextWindowEnd,
    pingedStart: false, pinged1h: false, pinged20min: false, boss,
  };

  // Fire stale timer alert on 2nd+ advance (or always for cryonox since maxMissed=2)
  if (count >= 2) {
    const tsOpen  = Math.floor(nextWindowStart / 1000);
    const tsClose = Math.floor(nextWindowEnd   / 1000);
    const atMax   = cfg.maxMissed !== Infinity && count >= cfg.maxMissed;
    const content = atMax
      ? `@everyone 🚫 **${boss.name}** has missed its spawn window **${count} times** — this is the final auto-advance!\n` +
        `Please find and kill the boss to reset the timer.\n` +
        `📍 Final estimated window: ${toServerTimeStr(nextWindowStart)} – ${toServerTimeStr(nextWindowEnd)} (server)\n` +
        `<t:${tsOpen}:t> — <t:${tsClose}:t> (your time)`
      : `@everyone 🚨 **${boss.name}** has missed its spawn window **${count} times** in a row!\n` +
        `The timer is likely wrong — please find and kill the boss to reset it.\n` +
        `📍 Next estimated window: ${toServerTimeStr(nextWindowStart)} – ${toServerTimeStr(nextWindowEnd)} (server)\n` +
        `<t:${tsOpen}:t> — <t:${tsClose}:t> (your time)`;
    postEveryoneWarning(channel, `${id}_stale_timer`, content, 30 * 60 * 1000);
  }
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
        await checkFixedEvents(channel);
        return;
      }

      try {
        await dashboardMessage.edit({ embeds: [buildEmbed()], components: buildButtons() });
      } catch (err) {
        if (err.code === 10008) { console.warn("[Loop] Dashboard deleted — repinning."); dashboardMessage = null; }
        else if (err.status !== 503 && err.status !== 502) {
          console.error("[Loop] Dashboard edit failed:", err.code, err.message);
          if (err.code !== 50013) dashboardMessage = null;
        }
      }

      for (const [id, w] of Object.entries(spawnWindowMessages)) {
        if (!w.msg) continue;
        try { await w.msg.edit({ embeds: [buildSpawnWindowEmbed(w.boss, w.windowStart, w.windowEnd)], components: buildSpawnWindowComponents(id) }); }
        catch (err) { if (err.code === 10008) delete spawnWindowMessages[id]; }
      }

      for (const [id, w] of Object.entries(missedWindowMessages)) {
        if (!w.msg) continue;
        try { await w.msg.edit({ embeds: [buildMissedWindowEmbed(w.boss, w.nextWindowStart, w.nextWindowEnd)], components: buildMissedWindowComponents(id) }); }
        catch (err) { if (err.code === 10008) delete missedWindowMessages[id]; }
      }

      tickMissedWindowPings(channel, now);
      checkWarnings(channel);
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
      channel.send({
        embeds: [buildMissedWindowEmbed(w.boss, w.nextWindowStart, w.nextWindowEnd)],
        components: buildMissedWindowComponents(id), flags: MessageFlags.SuppressNotifications
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
      postEveryoneWarning(channel, `${id}_missed_1h`,
        `@everyone ⏳ **${w.boss.name}** missed-window: **1 hour remaining**!\n⚠️ This timer might be incorrect.`);
    }

    if (!w.pinged20min && untilEnd > 0 && untilEnd <= 20 * 60 * 1000) {
      w.pinged20min = true;
      postEveryoneWarning(channel, `${id}_missed_20min`,
        `@everyone ⚠️ **${w.boss.name}** missed-window: **20 minutes remaining** in the spawn window!`);
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
    const cfg = bossConfig(b);
    const e   = data.kills[b.id];
    if (!e) continue;

    const cooldown               = e.respawnTime - now;
    const windowEnd              = e.respawnTime + cfg.respawnWindowMs;
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
// FIXED EVENT WARNINGS
// =====================
async function checkFixedEvents(channel) {
  const now = Date.now();

  for (const ev of FIXED_EVENTS) {
    for (const hhmm of ev.times) {
      const eventMs   = nextOccurrenceMs(hhmm, now);
      const warnMs    = ev.warnMinutes * 60 * 1000;
      const timeUntil = eventMs - now;

      if (timeUntil > warnMs + (1 * 60 * 1000) || timeUntil < -TICK_RATE) continue;

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
// CLEANUP HELPER
// =====================
function clearBossCards(id) {
  missedCount[id] = 0; // reset on any kill or manual set
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

  // ── KILL BUTTON (regular bosses) ──
  if (interaction.isButton() && interaction.customId.startsWith("kill_")) {
    snapshot();
    const id   = interaction.customId.replace("kill_", "");
    const boss = BOSSES.find(b => b.id === id);
    const cfg  = bossConfig(boss);
    const now  = Date.now();
    const respawnTime = now + cfg.respawnMs;
    data.kills[id] = { killTime: now, respawnTime, lastKiller: interaction.user.username };
    save();
    log(interaction.user, `KILLED ${boss.name} — kill: ${toServerDateTimeStr(now)} — respawn: ${toServerDateTimeStr(respawnTime)}`);
    spawnWarnings[id] = { warned5: false, warned20: false, windowCreated: false, missedHandled: false };
    clearBossCards(id);
    await announceKill(interaction.channel, interaction.user, `killed **${boss.name}**`,
      `🕒 Kill: ${toServerDateTimeStr(now)} — 🔄 Respawn: ${toServerDateTimeStr(respawnTime)}`);
    return interaction.deferUpdate();
  }

  // ── CRYONOX PICKER — step 1: choose location ──
  if (interaction.isButton() && interaction.customId === "cryonox_pick") {
    log(interaction.user, `Opened Cryonox location picker`);
    const menu = new StringSelectMenuBuilder()
      .setCustomId("cryonox_location")
      .setPlaceholder("Select location")
      .addOptions([
        { label: "🌀 Twisted Karutan — Server 1", value: "karutan_s1" },
        { label: "🌀 Twisted Karutan — Server 2", value: "karutan_s2" },
        { label: "🌀 Twisted Karutan — Server 3", value: "karutan_s3" },
        { label: "🏔️ Land of Trials",             value: "trials"    },
      ]);
    return interaction.reply({
      content: "❄️ **Cryonox** — Select location:",
      components: [new ActionRowBuilder().addComponents(menu)],
      flags: MessageFlags.Ephemeral,
    });
  }

  // ── CRYONOX PICKER — step 2: after location, pick slot ──
  if (interaction.isStringSelectMenu() && interaction.customId === "cryonox_location") {
    const loc = interaction.values[0]; // e.g. "karutan_s1" or "trials"
    log(interaction.user, `Cryonox location selected: ${loc}`);

    let options;
    if (loc === "trials") {
      options = [
        { label: "Cryonox #1 — Trials", value: "cryonox_trials_1" },
        { label: "Cryonox #2 — Trials", value: "cryonox_trials_2" },
      ];
    } else {
      const sNum = loc.replace("karutan_s", "");
      options = [1, 2, 3, 4].map(i => ({
        label: `Cryonox #${i} — Karutan S${sNum}`,
        value: `cryonox_karutan_s${sNum}_${i}`,
      }));
    }

    const menu = new StringSelectMenuBuilder()
      .setCustomId("cryonox_slot")
      .setPlaceholder("Select which Cryonox")
      .addOptions(options);

    return interaction.update({
      content: "❄️ **Cryonox** — Select which one was killed:",
      components: [new ActionRowBuilder().addComponents(menu)],
    });
  }

  // ── CRYONOX PICKER — step 3: after slot chosen, show kill-time modal ──
  if (interaction.isStringSelectMenu() && interaction.customId === "cryonox_slot") {
    const id   = interaction.values[0];
    const boss = BOSSES.find(b => b.id === id);
    log(interaction.user, `Cryonox slot selected: ${boss.name} — opening kill-time modal`);

    const modal = new ModalBuilder()
      .setCustomId(`cryonox_killtime_${id}`)
      .setTitle(`Kill Time — ${boss.name}`);
    modal.addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId("time")
        .setLabel("Kill time HH:MM (24h, server time)")
        .setStyle(TextInputStyle.Short)
        .setPlaceholder("e.g. 14:35")
        .setRequired(true)
    ));
    return interaction.showModal(modal);
  }

  // ── CRYONOX — modal submit (kill time) ──
  if (interaction.isModalSubmit() && interaction.customId.startsWith("cryonox_killtime_")) {
    snapshot();
    const id   = interaction.customId.replace("cryonox_killtime_", "");
    const boss = BOSSES.find(b => b.id === id);
    const cfg  = bossConfig(boss);
    const [h, m] = interaction.fields.getTextInputValue("time").split(":").map(Number);
    const kill    = parseServerTime(h, m);
    // respawnTime = kill + 5h (window opens); windowEnd = kill + 7h (window closes)

    const respawnTime = kill.getTime() + cfg.respawnMs;
    const windowEndCry = respawnTime + cfg.respawnWindowMs;
    clearBossCards(id);
    data.kills[id] = { killTime: kill.getTime(), respawnTime, lastKiller: interaction.user.username };
    save();
    log(interaction.user, `CRYONOX SET ${boss.name} — kill: ${toServerDateTimeStr(kill.getTime())} — window: ${toServerDateTimeStr(respawnTime)} – ${toServerDateTimeStr(windowEndCry)}`);
    spawnWarnings[id] = { warned5: false, warned20: false, windowCreated: false, missedHandled: false };
    await announceKill(interaction.channel, interaction.user, `logged **${boss.name}** kill`,
      `🕒 Kill: ${toServerDateTimeStr(kill.getTime())}\n🟢 Window opens: ${toServerDateTimeStr(respawnTime)} — 🔴 Closes: ${toServerDateTimeStr(windowEndCry)}`);
    return interaction.deferUpdate();
  }

  // ── WINDOW KILL ──
  if (interaction.isButton() && interaction.customId.startsWith("window_kill_")) {
    snapshot();
    const id   = interaction.customId.replace("window_kill_", "");
    const boss = BOSSES.find(b => b.id === id);
    const cfg  = bossConfig(boss);
    const now  = Date.now();
    const respawnTime = now + cfg.respawnMs;
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
    const id   = interaction.customId.replace("window_killtime_", "");
    const boss = BOSSES.find(b => b.id === id);
    const cfg  = bossConfig(boss);
    const [h, m] = interaction.fields.getTextInputValue("time").split(":").map(Number);
    const kill    = parseServerTime(h, m);
    const respawnTime = kill.getTime() + cfg.respawnMs;
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
    const id   = interaction.customId.replace("missed_kill_", "");
    const boss = BOSSES.find(b => b.id === id);
    const cfg  = bossConfig(boss);
    const now  = Date.now();
    const respawnTime = now + cfg.respawnMs;
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
    const modal = new ModalBuilder().setCustomId("missed_killtime_" + id).setTitle(`Set Kill Time — ${boss.name}`);
    modal.addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId("time").setLabel("HH:MM (24h, server time)").setStyle(TextInputStyle.Short)
    ));
    return interaction.showModal(modal);
  }

  // ── MISSED SET TIME — modal submit ──
  if (interaction.isModalSubmit() && interaction.customId.startsWith("missed_killtime_")) {
    snapshot();
    const id   = interaction.customId.replace("missed_killtime_", "");
    const boss = BOSSES.find(b => b.id === id);
    const cfg  = bossConfig(boss);
    const [h, m] = interaction.fields.getTextInputValue("time").split(":").map(Number);
    const kill    = parseServerTime(h, m);
    const respawnTime = kill.getTime() + cfg.respawnMs;
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
    // Only show non-cryonox bosses here; Cryonox has its own flow via the ❄️ button
    const insertableBosses = BOSSES.filter(b => b.type !== "cryonox");
    const menu = new StringSelectMenuBuilder()
      .setCustomId("select_boss_insert").setPlaceholder("Select boss")
      .addOptions(insertableBosses.map(b => ({ label: b.name, value: b.id })));
    return interaction.reply({
      content: "📝 Select boss — enter kill time in server time (HH:MM, 24h):\n*(For Cryonox, use the ❄️ button instead)*",
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
    const id   = interaction.customId.replace("killtime_server_", "");
    const boss = BOSSES.find(b => b.id === id);
    const cfg  = bossConfig(boss);
    const [h, m] = interaction.fields.getTextInputValue("time").split(":").map(Number);
    const kill    = parseServerTime(h, m);
    const respawnTime = kill.getTime() + cfg.respawnMs;
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
    return interaction.reply({ embeds: [buildLogEmbed()], flags: MessageFlags.Ephemeral });
  }
});

client.login(TOKEN);
