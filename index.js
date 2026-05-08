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

// =====================
// CONFIG (from environment variables)
// Set BOT_TOKEN, CHANNEL_ID, LOG_CHANNEL_ID, and DATA_BACKUP_CHANNEL_ID
// in Railway / your host's env settings. Never commit these values to GitHub.
//
// DATA_BACKUP_CHANNEL_ID — the private "bot-logs" channel where the 7
//   rotating backup slots are posted. The bot also reads this channel on
//   startup to restore timers after a redeploy.
// =====================
const TOKEN                  = process.env.BOT_TOKEN;
const CHANNEL_ID             = process.env.CHANNEL_ID;
const LOG_CHANNEL_ID         = process.env.LOG_CHANNEL_ID;
const DATA_BACKUP_CHANNEL_ID = process.env.DATA_BACKUP_CHANNEL_ID;

if (!TOKEN || !CHANNEL_ID) {
  console.error("ERROR: Missing BOT_TOKEN or CHANNEL_ID environment variables.");
  process.exit(1);
}
if (!LOG_CHANNEL_ID) {
  console.warn("[Warn] LOG_CHANNEL_ID not set — kill/action logs will not be forwarded to a private channel.");
}
if (!DATA_BACKUP_CHANNEL_ID) {
  console.warn("[Warn] DATA_BACKUP_CHANNEL_ID not set — timer backups will not be posted to bot-logs, and redeploy recovery is disabled.");
}

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

let spawnWarnings       = {};
let spawnWindowMessages = {};
let adminLogs  = [];
let undoStack  = [];

// Tracks missed-window dashboards for Kharzul/Vescrya auto-advance feature.
let missedWindowDashboards = {};

// Persistent Discord messages — posted once on startup, edited forever.
const MAX_DISCORD_BACKUPS = 7;
let backupMessages  = [];
let backupSlotIndex = 0;
let logMessage      = null;

const REPIN_AFTER_INTERACTIONS = 3;
const REPIN_AFTER_MS = 3 * 60 * 1000;
let interactionCount = 0;
let lastRepinTime    = Date.now();

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

// Bosses that get the missed-window / auto-advance feature
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

function nextOccurrenceMs(hhmm, afterMs) {
  const [h, m]  = hhmm.split(":").map(Number);
  const afterDt = new Date(afterMs);

  for (let dayOffset = 0; dayOffset <= 1; dayOffset++) {
    const base = new Date(afterDt);
    base.setDate(base.getDate() + dayOffset);
    const dateStr = base.toLocaleDateString("en-CA", { timeZone: SERVER_TZ });
    const candidate = new Date(`${dateStr}T${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}:00`);
    const tzOffset  = getAmsterdamOffsetMs(candidate);
    const utcMs     = candidate.getTime() - tzOffset;
    if (utcMs >= afterMs) return utcMs;
  }

  const afterDt2 = new Date(afterMs);
  afterDt2.setDate(afterDt2.getDate() + 1);
  const dateStr2 = afterDt2.toLocaleDateString("en-CA", { timeZone: SERVER_TZ });
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
        // Recover if no kills exist, or every kill's respawn window has been
        // expired for more than 2 hours (i.e. the data is stale/wiped)
        return !d.kills || Object.values(d.kills).every(e => e.respawnTime < now - 2 * 60 * 60 * 1000);
      } catch { return true; }
    })();

  if (!localEmpty) {
    console.log("[Recovery] Local data.json exists and has timers — skipping Discord recovery.");
    return false;
  }

  console.log("[Recovery] No local timer data found. Attempting to restore from Discord backup channel...");

  try {
    const backupCh = await client.channels.fetch(DATA_BACKUP_CHANNEL_ID);
    const messages = await backupCh.messages.fetch({ limit: 50 });

    const backupMsg = messages.find(m =>
      m.author.id === client.user.id &&
      m.attachments.size > 0 &&
      [...m.attachments.values()].some(a => a.name && a.name.endsWith(".json"))
    );

    if (!backupMsg) {
      console.warn("[Recovery] No backup messages with JSON attachments found in bot-logs channel.");
      return false;
    }

    const attachment = [...backupMsg.attachments.values()].find(a => a.name && a.name.endsWith(".json"));

    const response = await fetch(attachment.url);
    if (!response.ok) throw new Error(`HTTP ${response.status} fetching attachment`);
    const json = await response.json();

    if (!json.kills) throw new Error("Attachment JSON has no 'kills' field");

    data = json;
    save();

    const killCount = Object.keys(data.kills).length;
    console.log(`[Recovery] ✅ Restored ${killCount} timer(s) from Discord backup: "${attachment.name}" (sent ${backupMsg.createdAt.toISOString()})`);

    return true;
  } catch (err) {
    console.error("[Recovery] Failed to restore from Discord backup:", err);
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

  const now   = new Date();
  const stamp = now.toISOString().replace(/:/g, "-").replace("T", "_").slice(0, 16);
  const filename = `backups/data.backup-${stamp}.json`;
  fs.writeFileSync(filename, JSON.stringify(data, null, 2));

  const files = fs.readdirSync("backups")
    .filter(f => f.startsWith("data.backup-") && f.endsWith(".json"))
    .sort();
  if (files.length > MAX_LOCAL_BACKUPS) {
    for (const f of files.slice(0, files.length - MAX_LOCAL_BACKUPS)) {
      fs.unlinkSync(`backups/${f}`);
    }
  }

  return filename;
}

// =====================
// BACKUP — Discord persistent slots
// FIX: On redeploy, REUSE existing backup slot messages instead of posting
//      7 fresh empty ones (which would overwrite the real saved data).
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
    .setFooter({ text: `Last updated: ${stamp} (server time) — attach JSON used for redeploy recovery` });
}

async function initBackupMessages(backupChannel) {
  // Try to reuse existing backup slot messages from the channel.
  // This prevents overwriting real timer data on every redeploy.
  try {
    const existing = await backupChannel.messages.fetch({ limit: 50 });
    const botBackups = [...existing.values()]
      .filter(m =>
        m.author.id === client.user.id &&
        m.embeds.length > 0 &&
        m.embeds[0]?.title?.startsWith("💾 Backup Slot")
      )
      .sort((a, b) => a.createdTimestamp - b.createdTimestamp);

    if (botBackups.length === MAX_DISCORD_BACKUPS) {
      backupMessages  = botBackups;
      backupSlotIndex = 0;
      console.log(`[Backup] Reusing ${MAX_DISCORD_BACKUPS} existing backup slot messages — no data overwrite.`);
      return;
    }

    console.log(`[Backup] Found ${botBackups.length}/${MAX_DISCORD_BACKUPS} existing slots — posting fresh set.`);
  } catch (err) {
    console.warn("[Backup] Could not fetch existing backup messages — posting fresh set.", err);
  }

  // Post fresh slots only if we couldn't find a full existing set.
  backupMessages  = [];
  backupSlotIndex = 0;
  for (let i = 1; i <= MAX_DISCORD_BACKUPS; i++) {
    const now      = Date.now();
    const isoStamp = new Date(now).toISOString().replace(/:/g, "-").slice(0, 16);
    const msg = await backupChannel.send({
      embeds: [buildBackupEmbed(i, null)],
      files: [{
        attachment: Buffer.from(JSON.stringify(data, null, 2), "utf8"),
        name: `backup-slot${i}-${isoStamp}.json`
      }],
      flags: MessageFlags.SuppressNotifications
    });
    backupMessages.push(msg);
  }
  console.log(`[Backup] ${MAX_DISCORD_BACKUPS} fresh backup slots posted in bot-logs channel.`);
}

async function updateDiscordBackupSlot() {
  if (backupMessages.length === 0) return;
  const slot       = backupSlotIndex % MAX_DISCORD_BACKUPS;
  const slotNumber = slot + 1;
  const now        = Date.now();
  const isoStamp   = new Date(now).toISOString().replace(/:/g, "-").slice(0, 16);

  try {
    await backupMessages[slot].edit({
      embeds: [buildBackupEmbed(slotNumber, now)],
      files: [{
        attachment: Buffer.from(JSON.stringify(data, null, 2), "utf8"),
        name: `backup-slot${slotNumber}-${isoStamp}.json`
      }]
    });
    console.log(`[Backup] Discord slot ${slotNumber} updated in bot-logs.`);
  } catch (err) {
    console.error(`[Backup] Failed to edit slot ${slotNumber}:`, err);
  }

  backupSlotIndex = (backupSlotIndex + 1) % MAX_DISCORD_BACKUPS;
}

async function runBackup() {
  try {
    const localFile = saveLocalBackup();
    console.log(`[Backup] Local backup saved: ${localFile}`);
    await updateDiscordBackupSlot();
  } catch (err) {
    console.error(`[Backup] Error during backup:`, err);
  }
}

function startBackupLoop() {
  const now = new Date();
  const msUntilNextHour =
    BACKUP_INTERVAL_MS -
    (now.getMinutes() * 60000 + now.getSeconds() * 1000 + now.getMilliseconds());

  console.log(`[Backup] First backup in ${Math.round(msUntilNextHour / 60000)} minute(s), then every hour.`);

  setTimeout(() => {
    runBackup();
    setInterval(() => runBackup(), BACKUP_INTERVAL_MS);
  }, msUntilNextHour);
}

// =====================
// PERSISTENT LOG MESSAGE (public channel)
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
  logMessage = await channel.send({
    embeds: [buildLogEmbed()],
    flags: MessageFlags.SuppressNotifications
  });
  console.log("[Log] Persistent log message posted.");
}

async function updateLogMessage() {
  if (!logMessage) return;
  try {
    await logMessage.edit({ embeds: [buildLogEmbed()] });
  } catch (err) {
    console.error("[Log] Failed to update log message:", err);
  }
}

// =====================
// FORMAT
// =====================
function format(ms) {
  if (ms <= 0) return "NOW";
  const m = Math.floor(ms / 60000);
  const h = Math.floor(m / 60);
  const r = m % 60;
  return h > 0 ? `${h}h ${r}m` : `${m}m`;
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
// UNDO SYSTEM
// =====================
function snapshot() {
  undoStack.push(JSON.parse(JSON.stringify(data)));
  if (undoStack.length > MAX_UNDO) undoStack.shift();
}

function undo() {
  if (undoStack.length === 0) return false;
  data = undoStack.pop();
  save();
  return true;
}

// =====================
// ANNOUNCE HELPERS
// FIX: forwardToLogChannel sends to the PRIVATE log channel only.
//      The public channel only gets kill announcements (permanent) and
//      admin announcements (auto-deleted after 10 min). No spam.
// =====================
async function announceKill(channel, user, action, extra = "") {
  const now     = Date.now();
  const content = `⚔️ **${user.username}** ${action} — ${toServerDateTimeStr(now)} (server time)${extra ? `\n${extra}` : ""}`;
  await channel.send({ content, flags: MessageFlags.SuppressNotifications });
  forwardToLogChannel(content);
}

async function announceAdmin(channel, user, action, extra = "") {
  const now     = Date.now();
  const content = `📢 **${user.username}** ${action} — ${toServerDateTimeStr(now)} (server time)${extra ? `\n${extra}` : ""}`;
  const msg     = await channel.send({ content, flags: MessageFlags.SuppressNotifications });
  setTimeout(() => {
    msg.delete().catch(() => {});
  }, 10 * 60 * 1000);
  forwardToLogChannel(content);
}

async function forwardToLogChannel(content) {
  if (!LOG_CHANNEL_ID) return;
  // Never forward to the same channel to avoid double-posting
  if (LOG_CHANNEL_ID === CHANNEL_ID) return;
  try {
    const logCh = await client.channels.fetch(LOG_CHANNEL_ID);
    await logCh.send({ content, flags: MessageFlags.SuppressNotifications });
  } catch (err) {
    console.error("[Log Channel] Failed to forward message:", err);
  }
}

// =====================
// SPAWN WINDOW
// =====================
async function createSpawnWindow(boss, id, channel, windowEnd) {
  if (spawnWindowMessages[id]) return;

  const msg = await channel.send({
    embeds: [
      new EmbedBuilder()
        .setTitle(`⚠️ ${boss.name} MAY SPAWN`)
        .setColor(0xffcc00)
        .setDescription(`🔥 Boss: **${boss.name}**\n⏳ Live window started`)
    ],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId("window_kill_" + id)
          .setLabel("💀 Killed")
          .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
          .setCustomId("window_settime_" + id)
          .setLabel("⏱️ Set Time")
          .setStyle(ButtonStyle.Secondary)
      )
    ],
    flags: MessageFlags.SuppressNotifications
  });

  spawnWindowMessages[id] = { msg, windowEnd, boss };

  // FIX: Extended from 15 to 25 minutes past windowEnd so the message
  // lingers long enough for the 10-minute missed-window grace period.
  const deleteAfter = (windowEnd - Date.now()) + 25 * 60 * 1000;
  setTimeout(() => {
    msg.delete().catch(() => {});
    delete spawnWindowMessages[id];
  }, deleteAfter);
}

async function recreateActiveSpawnWindows(channel) {
  const now = Date.now();
  for (const id in spawnWindowMessages) {
    const w = spawnWindowMessages[id];
    w.msg.delete().catch(() => {});
    delete spawnWindowMessages[id];
    if (w.windowEnd > now) {
      await createSpawnWindow(w.boss, id, channel, w.windowEnd);
    }
  }
}

// =====================
// MISSED WINDOW / AUTO-ADVANCE (Kharzul & Vescrya only)
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

  if (missedWindowDashboards[id]) {
    missedWindowDashboards[id].msg.delete().catch(() => {});
    delete missedWindowDashboards[id];
  }

  const nextWindowStart = e.respawnTime;
  const nextWindowEnd   = e.respawnTime + 2 * 60 * 60 * 1000;

  const msg = await channel.send({
    embeds: [buildMissedWindowEmbed(boss, nextWindowStart, nextWindowEnd)],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId("missed_kill_" + id)
          .setLabel("💀 Killed")
          .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
          .setCustomId("missed_settime_" + id)
          .setLabel("⏱️ Set Time")
          .setStyle(ButtonStyle.Secondary)
      )
    ],
    flags: MessageFlags.SuppressNotifications
  });

  missedWindowDashboards[id] = {
    msg,
    nextWindowStart,
    nextWindowEnd,
    pingedStart: false,
    pinged1h:    false,
    pinged20min: false,
    boss,
  };

  const ttl = (nextWindowEnd - Date.now()) + 15 * 60 * 1000;
  setTimeout(() => {
    msg.delete().catch(() => {});
    delete missedWindowDashboards[id];
  }, Math.max(ttl, 0));
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

async function tickMissedWindowDashboards(channel) {
  const now = Date.now();

  for (const id in missedWindowDashboards) {
    const w = missedWindowDashboards[id];

    w.msg.edit({
      embeds: [buildMissedWindowEmbed(w.boss, w.nextWindowStart, w.nextWindowEnd)]
    }).catch(() => {});

    const untilStart = w.nextWindowStart - now;
    const untilEnd   = w.nextWindowEnd   - now;

    if (!w.pingedStart && untilStart <= 0 && untilEnd > 0) {
      w.pingedStart = true;
      channel.send(
        `@everyone 🔶 **${w.boss.name}** next possible spawn window is now open!\n` +
        `⚠️ This timer might be incorrect — boss may take longer to respawn.\n` +
        `Window closes in **${format(untilEnd)}** (${toServerTimeStr(w.nextWindowEnd)} server time)`
      );
    }

    if (!w.pinged1h && untilEnd > 0 && untilEnd <= 60 * 60 * 1000) {
      w.pinged1h = true;
      channel.send(
        `@everyone ⏳ **${w.boss.name}** missed-window: **1 hour remaining** in the spawn window!\n` +
        `⚠️ This timer might be incorrect.`
      );
    }

    if (!w.pinged20min && untilEnd > 0 && untilEnd <= 20 * 60 * 1000) {
      w.pinged20min = true;
      channel.send(
        `@everyone ⚠️ **${w.boss.name}** missed-window: **20 minutes remaining** in the spawn window!`
      );
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

      if (timeUntil > warnMs || timeUntil < 0) continue;

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

    if (cooldown <= 0 && windowLeft > 0) {
      const tsRespawn  = Math.floor(e.respawnTime / 1000);
      const serverTime = toServerTimeStr(e.respawnTime);
      text = `🟢 WINDOW — ⏳ ${format(windowLeft)}\n🕒 Was due: ${serverTime} (server) — <t:${tsRespawn}:t> (your time)\n👤 ${e.lastKiller}`;
    } else if (windowLeft <= 0) {
      const serverTime = toServerDateTimeStr(e.respawnTime);
      text = `⚠️ Timer possibly wrong\n🕒 Last known respawn: ${serverTime} (server)\n👤 ${e.lastKiller}`;
      isBroken = true;
    } else {
      const tsRespawn  = Math.floor(e.respawnTime / 1000);
      const serverTime = toServerTimeStr(e.respawnTime);
      text =
        `🔴 ${format(cooldown)}\n` +
        `🕒 ${serverTime} (server) — <t:${tsRespawn}:t> (your time)\n` +
        `👤 ${e.lastKiller}`;
    }

    return { name: b.name, timeLeft: Math.max(cooldown, windowLeft), text, isBroken };
  });

  bosses.sort((a, b) => {
    if (a.isBroken && !b.isBroken) return 1;
    if (!a.isBroken && b.isBroken) return -1;
    return a.timeLeft - b.timeLeft;
  });

  for (const b of bosses) {
    embed.addFields({ name: `• ${b.name}`, value: b.text });
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

  for (const group of chunk(BOSSES, 5)) {
    const row = new ActionRowBuilder();
    for (const b of group) {
      row.addComponents(
        new ButtonBuilder()
          .setCustomId("kill_" + b.id)
          .setLabel(b.name.slice(0, 20))
          .setStyle(ButtonStyle.Primary)
      );
    }
    rows.push(row);
  }

  rows.push(
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("insert_time").setLabel("📝 Insert").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("reset_all").setLabel("🧹 Reset").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId("undo").setLabel("↩️ Undo").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("show_logs").setLabel("📜 Logs").setStyle(ButtonStyle.Secondary)
    )
  );

  return rows;
}

// =====================
// REPIN DASHBOARD
// =====================
async function repinDashboard(channel) {
  if (dashboardMessage) await dashboardMessage.delete().catch(() => {});

  dashboardMessage = await channel.send({
    embeds: [buildEmbed()],
    components: buildButtons(),
    flags: MessageFlags.SuppressNotifications
  });

  interactionCount = 0;
  lastRepinTime    = Date.now();

  await recreateActiveSpawnWindows(channel);
}

// =====================
// MAIN LOOP
// =====================
function startLoop() {
  setInterval(async () => {
    if (!dashboardMessage) return;

    const channel = dashboardMessage.channel;

    if (Date.now() - lastRepinTime >= REPIN_AFTER_MS) {
      await repinDashboard(channel);
      checkWarnings(channel);
      await tickMissedWindowDashboards(channel);
      await checkFixedEvents(channel);
      return;
    }

    try {
      await dashboardMessage.edit({
        embeds: [buildEmbed()],
        components: buildButtons()
      });
    } catch (err) {
      if (err.code === 10008) {
        await repinDashboard(channel);
        checkWarnings(channel);
        await tickMissedWindowDashboards(channel);
        await checkFixedEvents(channel);
        return;
      }
    }

    const now = Date.now();
    for (const id in spawnWindowMessages) {
      const w         = spawnWindowMessages[id];
      const remaining = w.windowEnd - now;
      if (remaining <= 0) continue;
      w.msg.edit({
        embeds: [
          new EmbedBuilder()
            .setTitle(`⚠️ ${w.boss.name} SPAWN WINDOW ACTIVE`)
            .setColor(0xffcc00)
            .setDescription(`🔥 Boss: **${w.boss.name}**\n⏳ Time left: **${format(remaining)}**`)
        ]
      }).catch(() => {});
    }

    checkWarnings(channel);
    await tickMissedWindowDashboards(channel);
    await checkFixedEvents(channel);
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

    if (!spawnWarnings[b.id]) {
      spawnWarnings[b.id] = { warned5: false, warned20: false, windowCreated: false, missedHandled: false };
    }

    const w = spawnWarnings[b.id];

    if (cooldown > 0 && cooldown <= 5 * 60 * 1000 && !w.warned5) {
      w.warned5 = true;
      channel.send(`@everyone ⏳ **${b.name}** spawns in 5 minutes`);
    }

    if (cooldown <= 0 && windowLeft > 2 * 60 * 1000 && windowLeft <= 20 * 60 * 1000 && !w.warned20) {
      w.warned20 = true;
      channel.send(`@everyone ⚠️ **${b.name}** may spawn in 20 minutes`);
    }

    if (cooldown <= 0 && windowLeft > 0 && !w.windowCreated) {
      w.windowCreated = true;
      createSpawnWindow(b, b.id, channel, windowEnd);
    }

    // FIX: Wait 10 minutes after window expiry before auto-advancing,
    // giving the spawn window message time to linger and be acted on.
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
// READY
// =====================
client.once(Events.ClientReady, async () => {
  console.log("Bot online");
  load();

  const recovered = await recoverFromDiscordBackup();
  if (recovered) {
    console.log("[Recovery] Timer data restored from Discord backup — resuming normally.");
  }

  const channel = await client.channels.fetch(CHANNEL_ID);

  await initLogMessage(channel);

  if (DATA_BACKUP_CHANNEL_ID) {
    try {
      const backupCh = await client.channels.fetch(DATA_BACKUP_CHANNEL_ID);
      await initBackupMessages(backupCh);
    } catch (err) {
      console.error("[Backup] Could not fetch DATA_BACKUP_CHANNEL_ID:", err);
      await initBackupMessages(channel);
    }
  } else {
    await initBackupMessages(channel);
  }

  dashboardMessage = await channel.send({
    embeds: [buildEmbed()],
    components: buildButtons(),
    flags: MessageFlags.SuppressNotifications
  });

  startLoop();
  startBackupLoop();
});

// =====================
// INTERACTIONS
// =====================
client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isButton() && !interaction.isStringSelectMenu() && !interaction.isModalSubmit()) return;

  interactionCount++;
  if (interactionCount >= REPIN_AFTER_INTERACTIONS && dashboardMessage) {
    await repinDashboard(dashboardMessage.channel);
  }

  // =====================
  // KILL BUTTON
  // =====================
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

    if (missedWindowDashboards[id]) {
      missedWindowDashboards[id].msg.delete().catch(() => {});
      delete missedWindowDashboards[id];
    }

    await announceKill(
      interaction.channel, interaction.user,
      `killed **${boss.name}**`,
      `🕒 Kill: ${toServerDateTimeStr(now)} — 🔄 Respawn: ${toServerDateTimeStr(respawnTime)}`
    );

    return interaction.deferUpdate();
  }

  // =====================
  // WINDOW KILL
  // =====================
  if (interaction.isButton() && interaction.customId.startsWith("window_kill_")) {
    snapshot();

    const id          = interaction.customId.replace("window_kill_", "");
    const boss        = BOSSES.find(b => b.id === id);
    const now         = Date.now();
    const respawnTime = now + 7 * 60 * 60 * 1000;

    if (spawnWindowMessages[id]) {
      spawnWindowMessages[id].msg.delete().catch(() => {});
      delete spawnWindowMessages[id];
    }
    if (missedWindowDashboards[id]) {
      missedWindowDashboards[id].msg.delete().catch(() => {});
      delete missedWindowDashboards[id];
    }

    data.kills[id] = { killTime: now, respawnTime, lastKiller: interaction.user.username };
    save();
    log(interaction.user, `WINDOW KILL ${boss.name} — kill: ${toServerDateTimeStr(now)} — respawn: ${toServerDateTimeStr(respawnTime)}`);
    spawnWarnings[id] = { warned5: false, warned20: false, windowCreated: false, missedHandled: false };

    await announceKill(
      interaction.channel, interaction.user,
      `killed **${boss.name}** (window kill)`,
      `🕒 Kill: ${toServerDateTimeStr(now)} — 🔄 Respawn: ${toServerDateTimeStr(respawnTime)}`
    );

    return interaction.deferUpdate();
  }

  // =====================
  // WINDOW SET TIME — show modal
  // =====================
  if (interaction.isButton() && interaction.customId.startsWith("window_settime_")) {
    const id   = interaction.customId.replace("window_settime_", "");
    const boss = BOSSES.find(b => b.id === id);

    log(interaction.user, `Opened set-time modal for ${boss.name} (window)`);

    const modal = new ModalBuilder()
      .setCustomId("window_killtime_" + id)
      .setTitle(`Set Kill Time — ${boss.name}`);
    modal.addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId("time").setLabel("HH:MM (24h, server time)").setStyle(TextInputStyle.Short)
    ));

    return interaction.showModal(modal);
  }

  // WINDOW SET TIME — modal submit
  if (interaction.isModalSubmit() && interaction.customId.startsWith("window_killtime_")) {
    snapshot();

    const id          = interaction.customId.replace("window_killtime_", "");
    const boss        = BOSSES.find(b => b.id === id);
    const [h, m]      = interaction.fields.getTextInputValue("time").split(":").map(Number);
    const kill        = parseServerTime(h, m);
    const respawnTime = kill.getTime() + 7 * 60 * 60 * 1000;

    if (spawnWindowMessages[id]) {
      spawnWindowMessages[id].msg.delete().catch(() => {});
      delete spawnWindowMessages[id];
    }
    if (missedWindowDashboards[id]) {
      missedWindowDashboards[id].msg.delete().catch(() => {});
      delete missedWindowDashboards[id];
    }

    data.kills[id] = { killTime: kill.getTime(), respawnTime, lastKiller: interaction.user.username };
    save();
    log(interaction.user, `MANUAL SET (window) ${boss.name} — kill: ${toServerDateTimeStr(kill.getTime())} — respawn: ${toServerDateTimeStr(respawnTime)}`);
    spawnWarnings[id] = { warned5: false, warned20: false, windowCreated: false, missedHandled: false };

    await announceKill(
      interaction.channel, interaction.user,
      `manually set **${boss.name}** kill time (from window)`,
      `🕒 Kill: ${toServerDateTimeStr(kill.getTime())} — 🔄 Respawn: ${toServerDateTimeStr(respawnTime)}`
    );

    await repinDashboard(interaction.channel);
    return interaction.reply({ content: "✅ Kill time set!", flags: MessageFlags.Ephemeral });
  }

  // =====================
  // MISSED WINDOW — Kill button
  // =====================
  if (interaction.isButton() && interaction.customId.startsWith("missed_kill_")) {
    snapshot();

    const id          = interaction.customId.replace("missed_kill_", "");
    const boss        = BOSSES.find(b => b.id === id);
    const now         = Date.now();
    const respawnTime = now + 7 * 60 * 60 * 1000;

    if (missedWindowDashboards[id]) {
      missedWindowDashboards[id].msg.delete().catch(() => {});
      delete missedWindowDashboards[id];
    }

    data.kills[id] = { killTime: now, respawnTime, lastKiller: interaction.user.username };
    save();
    log(interaction.user, `MISSED-WINDOW KILL ${boss.name} — kill: ${toServerDateTimeStr(now)} — respawn: ${toServerDateTimeStr(respawnTime)}`);
    spawnWarnings[id] = { warned5: false, warned20: false, windowCreated: false, missedHandled: false };

    await announceKill(
      interaction.channel, interaction.user,
      `killed **${boss.name}** (missed-window kill)`,
      `🕒 Kill: ${toServerDateTimeStr(now)} — 🔄 Respawn: ${toServerDateTimeStr(respawnTime)}`
    );

    return interaction.deferUpdate();
  }

  // MISSED WINDOW — Set Time button
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

  // MISSED WINDOW — modal submit
  if (interaction.isModalSubmit() && interaction.customId.startsWith("missed_killtime_")) {
    snapshot();

    const id          = interaction.customId.replace("missed_killtime_", "");
    const boss        = BOSSES.find(b => b.id === id);
    const [h, m]      = interaction.fields.getTextInputValue("time").split(":").map(Number);
    const kill        = parseServerTime(h, m);
    const respawnTime = kill.getTime() + 7 * 60 * 60 * 1000;

    if (missedWindowDashboards[id]) {
      missedWindowDashboards[id].msg.delete().catch(() => {});
      delete missedWindowDashboards[id];
    }

    data.kills[id] = { killTime: kill.getTime(), respawnTime, lastKiller: interaction.user.username };
    save();
    log(interaction.user, `MANUAL SET (missed-window) ${boss.name} — kill: ${toServerDateTimeStr(kill.getTime())} — respawn: ${toServerDateTimeStr(respawnTime)}`);
    spawnWarnings[id] = { warned5: false, warned20: false, windowCreated: false, missedHandled: false };

    await announceKill(
      interaction.channel, interaction.user,
      `manually set **${boss.name}** kill time (from missed-window)`,
      `🕒 Kill: ${toServerDateTimeStr(kill.getTime())} — 🔄 Respawn: ${toServerDateTimeStr(respawnTime)}`
    );

    await repinDashboard(interaction.channel);
    return interaction.reply({ content: "✅ Kill time set!", flags: MessageFlags.Ephemeral });
  }

  // =====================
  // INSERT TIME — step 1: pick boss
  // =====================
  if (interaction.isButton() && interaction.customId === "insert_time") {
    log(interaction.user, `Opened insert: boss selection menu`);

    const menu = new StringSelectMenuBuilder()
      .setCustomId("select_boss_insert")
      .setPlaceholder("Select boss")
      .addOptions(BOSSES.map(b => ({ label: b.name, value: b.id })));

    return interaction.reply({
      content: "📝 Select boss — enter kill time in server time (HH:MM, 24h):",
      components: [new ActionRowBuilder().addComponents(menu)],
      flags: MessageFlags.Ephemeral
    });
  }

  // INSERT TIME — step 2: show modal directly
  if (interaction.isStringSelectMenu() && interaction.customId === "select_boss_insert") {
    const id   = interaction.values[0];
    const boss = BOSSES.find(b => b.id === id);

    log(interaction.user, `Insert: selected boss ${boss.name} — opening server time modal`);

    const modal = new ModalBuilder()
      .setCustomId(`killtime_server_${id}`)
      .setTitle(`Insert Kill Time — ${boss.name}`);
    modal.addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId("time")
        .setLabel("HH:MM (24h, server time)")
        .setStyle(TextInputStyle.Short)
        .setPlaceholder("e.g. 21:34")
    ));

    return interaction.showModal(modal);
  }

  // INSERT TIME — save (server time)
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
      missedWindowDashboards[id].msg.delete().catch(() => {});
      delete missedWindowDashboards[id];
    }

    await announceKill(
      interaction.channel, interaction.user,
      `manually set **${boss.name}** kill time`,
      `🕒 Kill: ${toServerDateTimeStr(kill.getTime())} — 🔄 Respawn: ${toServerDateTimeStr(respawnTime)}`
    );

    await repinDashboard(interaction.channel);
    return interaction.reply({ content: "✅ Kill time set!", flags: MessageFlags.Ephemeral });
  }

  // =====================
  // RESET — step 1: dropdown
  // =====================
  if (interaction.isButton() && interaction.customId === "reset_all") {
    log(interaction.user, `Opened reset selection menu`);

    const menu = new StringSelectMenuBuilder()
      .setCustomId("reset_select")
      .setPlaceholder("Select what to reset")
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

  // RESET — step 2: apply
  if (interaction.isStringSelectMenu() && interaction.customId === "reset_select") {
    snapshot();

    const value = interaction.values[0];

    if (value === "DELETE_ALL") {
      data.kills = {};
      save();
      for (const id in missedWindowDashboards) {
        missedWindowDashboards[id].msg.delete().catch(() => {});
      }
      missedWindowDashboards = {};
      log(interaction.user, `RESET ALL TIMERS`);
      await announceAdmin(interaction.channel, interaction.user, "reset **ALL** timers ☠️");
      return interaction.deferUpdate();
    }

    const boss = BOSSES.find(b => b.id === value);
    delete data.kills[value];
    spawnWarnings[value] = { warned5: false, warned20: false, windowCreated: false, missedHandled: false };
    if (missedWindowDashboards[value]) {
      missedWindowDashboards[value].msg.delete().catch(() => {});
      delete missedWindowDashboards[value];
    }
    save();
    log(interaction.user, `RESET timer for ${boss.name}`);
    await announceAdmin(interaction.channel, interaction.user, `reset timer for **${boss.name}**`);
    return interaction.deferUpdate();
  }

  // =====================
  // UNDO
  // =====================
  if (interaction.isButton() && interaction.customId === "undo") {
    const ok = undo();
    log(interaction.user, ok ? `UNDO success` : `UNDO failed — nothing to undo`);

    await announceAdmin(
      interaction.channel, interaction.user,
      ok ? "used **Undo** ↩️" : "tried to undo — nothing to undo"
    );

    return interaction.deferUpdate();
  }

  // =====================
  // LOGS
  // =====================
  if (interaction.isButton() && interaction.customId === "show_logs") {
    log(interaction.user, `Viewed logs`);
    return interaction.reply({ embeds: [buildLogEmbed()], flags: MessageFlags.Ephemeral });
  }
});

client.login(TOKEN);
