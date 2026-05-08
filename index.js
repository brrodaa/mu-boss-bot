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
if (!LOG_CHANNEL_ID)         console.warn("[Warn] LOG_CHANNEL_ID not set.");
if (!DATA_BACKUP_CHANNEL_ID) console.warn("[Warn] DATA_BACKUP_CHANNEL_ID not set.");

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages]
});

// =====================
// SETTINGS
// =====================
const TICK_RATE    = 5000;
const MAX_UNDO     = 10;

// How long before we repin everything to the bottom of chat.
const REPIN_AFTER_MS = 30 * 1000;

// @everyone warning card: lives 10 minutes, repins itself 1 minute before expiry.
const EVERYONE_WARNING_LIFESPAN_MS    = 10 * 60 * 1000;
const EVERYONE_REPIN_BEFORE_EXPIRE_MS =  1 * 60 * 1000;

// Spawn window card lives for the full 1h window + this grace period after it closes.
const SPAWN_WINDOW_GRACE_MS = 15 * 60 * 1000;

// =====================
// STATE
// =====================
let data = { kills: {} };
let dashboardMessage = null;

// spawnWarnings[bossId] = { warned5, warned20, windowCreated }
let spawnWarnings = {};

// spawnWindowMessages[bossId] = { msg, windowEnd, boss }
// These are managed entirely by the main loop — no setTimeout deletions.
let spawnWindowMessages = {};

// everyoneWarnings[key] = { msg, content, repinTimer, deleteTimer }
// Self-repinning @everyone cards.
let everyoneWarnings = {};

let adminLogs = [];
let undoStack = [];

const MAX_DISCORD_BACKUPS = 7;
let backupMessages  = [];
let backupSlotIndex = 0;
let logMessage      = null;

let lastRepinTime = Date.now();

// Tracks the last-known ordered list of window message IDs so we can
// detect when reordering is needed without a full rebuild every tick.
let lastWindowOrder = [];

// Prevents concurrent reorder operations from stepping on each other.
let reorderInProgress = false;

// =====================
// BOSSES
// =====================
function buildBosses() {
  const bosses = [];
  for (let i = 1; i <= 3; i++) bosses.push({ id: `lorencia_${i}`, name: `Kharzul #${i}` });
  for (let i = 1; i <= 3; i++) bosses.push({ id: `davias_${i}`,   name: `Vescrya #${i}` });
  for (let i = 1; i <= 2; i++) bosses.push({ id: `crywolf_${i}`,  name: `Muggron #${i} Crywolf` });
  for (let i = 1; i <= 2; i++) bosses.push({ id: `barracks_${i}`, name: `Muggron #${i} Barracks` });
  return bosses;
}
const BOSSES = buildBosses();

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
    const fetched  = await backupChannel.messages.fetch({ limit: 100 });
    const existing = [...fetched.values()]
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
// @EVERYONE WARNINGS — self-repinning cards
//
// Each warning lives for EVERYONE_WARNING_LIFESPAN_MS (10 min).
// One minute before it expires it deletes itself and reposts to stay
// visible at the bottom of chat. Cleared immediately when a kill is logged.
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
//
// The card is created by checkWarnings() when the respawn cooldown expires.
// It is kept alive and updated every tick by the main loop via in-place edits.
// It is deleted only when:
//   a) a kill is logged via the card's buttons, OR
//   b) windowEnd + SPAWN_WINDOW_GRACE_MS has passed (main loop expiry check).
// No setTimeout is used for deletion — lifetime is controlled by the loop.
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
    new ButtonBuilder().setCustomId("window_kill_"    + id).setLabel("💀 Killed").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("window_settime_" + id).setLabel("⏱️ Set Time").setStyle(ButtonStyle.Secondary)
  )];
}

// Safe to call multiple times — no-ops if the card already exists.
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
      const tsOpen  = Math.floor(nextWindowOpen  / 1000);
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
function computeWindowOrder() {
  const now   = Date.now();
  const spawn = [];
  for (const id in spawnWindowMessages) {
    const w = spawnWindowMessages[id];
    spawn.push({ key: `spawn:${id}`, timeRemaining: w.windowEnd - now, id });
  }
  spawn.sort((a, b) => a.timeRemaining - b.timeRemaining);
  return spawn;
}

// =====================
// ATOMIC FULL REPIN
//
// Deletes ALL managed messages (dashboard + all window cards) and reposts
// them in the correct fixed order: dashboard → spawn windows (soonest first).
// This is the only function that creates new messages, preventing jiggle.
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

    // 2. Post dashboard first.
    dashboardMessage = await channel.send({
      embeds: [buildEmbed()],
      components: buildButtons(),
      flags: MessageFlags.SuppressNotifications
    });
    lastRepinTime = now;

    // 3. Post spawn window cards for any boss whose window is currently open
    //    or within the grace period, sorted soonest-closing first.
    const windowBosses = BOSSES
      .map(b => {
        const e = data.kills[b.id];
        if (!e) return null;
        const windowEnd = e.respawnTime + 60 * 60 * 1000;
        // Skip if respawn cooldown hasn't expired yet (window not open).
        if (e.respawnTime > now) return null;
        // Skip if past the grace period.
        if (windowEnd + SPAWN_WINDOW_GRACE_MS < now) return null;
        return { b, windowEnd };
      })
      .filter(Boolean)
      .sort((a, b) => a.windowEnd - b.windowEnd);

    for (const { b, windowEnd } of windowBosses) {
      const msg = await channel.send({
        embeds: [buildSpawnWindowEmbed(b, windowEnd)],
        components: buildSpawnWindowComponents(b.id),
        flags: MessageFlags.SuppressNotifications
      });
      spawnWindowMessages[b.id] = { msg, windowEnd, boss: b };
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
// Every tick:
//   STEP 1 — Expire stale window cards (no API call).
//   STEP 2 — Fire warnings and create new window cards if needed.
//   STEP 3 — Liveness check for window cards (once per minute).
//   STEP 4 — Decide if a full repin is needed.
//   STEP 5 — Fast path: edit all messages in-place.
// =====================
let lastLivenessCheckTime = 0;
const LIVENESS_CHECK_INTERVAL = 60 * 1000;

function startLoop() {
  setInterval(async () => {
    if (!dashboardMessage) return;
    const channel = dashboardMessage.channel;
    const now = Date.now();

    // ── STEP 1: Expire stale spawn window cards ──────────────────────────
    for (const id of Object.keys(spawnWindowMessages)) {
      if (spawnWindowMessages[id].windowEnd + SPAWN_WINDOW_GRACE_MS < now) {
        spawnWindowMessages[id].msg && spawnWindowMessages[id].msg.delete().catch(() => {});
        delete spawnWindowMessages[id];
        lastWindowOrder = []; // trigger repin to reflect removal
      }
    }

    // ── STEP 2: Warnings and new window card creation ────────────────────
    checkWarnings(channel);

    // ── STEP 3: Periodic liveness check (catches manual message deletions) ─
    if (now - lastLivenessCheckTime >= LIVENESS_CHECK_INTERVAL) {
      lastLivenessCheckTime = now;
      let anyDead = false;
      for (const id of Object.keys(spawnWindowMessages)) {
        const alive = await spawnWindowMessages[id].msg.fetch().then(() => true).catch(() => false);
        if (!alive) { delete spawnWindowMessages[id]; anyDead = true; }
      }
      if (anyDead) lastWindowOrder = [];
    }

    // ── STEP 4: Decide whether a full repin is needed ────────────────────
    const desired       = computeWindowOrder().map(e => e.key);
    const orderChanged  = JSON.stringify(desired) !== JSON.stringify(lastWindowOrder);
    const dashboardDead = await dashboardMessage.fetch().then(() => false).catch(() => true);
    const repinDue      = now - lastRepinTime >= REPIN_AFTER_MS;

    if ((orderChanged || dashboardDead || repinDue) && !reorderInProgress) {
      await fullRepin(channel);
      return;
    }

    // ── STEP 5: Fast path — edit messages in-place ───────────────────────
    dashboardMessage.edit({ embeds: [buildEmbed()], components: buildButtons() }).catch(() => {});

    for (const id in spawnWindowMessages) {
      const w = spawnWindowMessages[id];
      w.msg.edit({
        embeds: [buildSpawnWindowEmbed(w.boss, w.windowEnd)],
        components: buildSpawnWindowComponents(id)
      }).catch(() => {});
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

    if (!spawnWarnings[b.id])
      spawnWarnings[b.id] = { warned5: false, warned20: false, windowCreated: false };

    const w = spawnWarnings[b.id];

    // 5-minute warning — @everyone, self-repinning card
    if (cooldown > 0 && cooldown <= 5 * 60 * 1000 && !w.warned5) {
      w.warned5 = true;
      postEveryoneWarning(channel, `${b.id}_5min`, `@everyone ⏳ **${b.name}** spawns in 5 minutes`);
    }

    // 20-minute window warning — @everyone, self-repinning card
    if (cooldown <= 0 && windowLeft > 2 * 60 * 1000 && windowLeft <= 20 * 60 * 1000 && !w.warned20) {
      w.warned20 = true;
      postEveryoneWarning(channel, `${b.id}_20min`, `@everyone ⚠️ **${b.name}** may spawn in 20 minutes`);
    }

    // Open the spawn window card
    if (cooldown <= 0 && windowLeft > 0 && !w.windowCreated) {
      w.windowCreated = true;
      createSpawnWindow(b, b.id, channel, windowEnd).then(() => {
        lastWindowOrder = []; // trigger repin so card appears in correct position
      });
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
    catch (err) { console.error("[Backup] Could not fetch DATA_BACKUP_CHANNEL_ID:", err); await initBackupMessages(channel); }
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
    spawnWarnings[id] = { warned5: false, warned20: false, windowCreated: false };
    await clearEveryoneWarning(`${id}_5min`);
    await clearEveryoneWarning(`${id}_20min`);
    if (spawnWindowMessages[id]) {
      spawnWindowMessages[id].msg && spawnWindowMessages[id].msg.delete().catch(() => {});
      delete spawnWindowMessages[id];
      lastWindowOrder = [];
    }

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
      lastWindowOrder = [];
    }

    data.kills[id] = { killTime: now, respawnTime, lastKiller: interaction.user.username };
    save();
    log(interaction.user, `WINDOW KILL ${boss.name} — kill: ${toServerDateTimeStr(now)} — respawn: ${toServerDateTimeStr(respawnTime)}`);
    spawnWarnings[id] = { warned5: false, warned20: false, windowCreated: false };
    await clearEveryoneWarning(`${id}_5min`);
    await clearEveryoneWarning(`${id}_20min`);

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
      lastWindowOrder = [];
    }

    data.kills[id] = { killTime: kill.getTime(), respawnTime, lastKiller: interaction.user.username };
    save();
    log(interaction.user, `MANUAL SET (window) ${boss.name} — kill: ${toServerDateTimeStr(kill.getTime())} — respawn: ${toServerDateTimeStr(respawnTime)}`);
    spawnWarnings[id] = { warned5: false, warned20: false, windowCreated: false };
    await clearEveryoneWarning(`${id}_5min`);
    await clearEveryoneWarning(`${id}_20min`);

    await announceKill(interaction.channel, interaction.user, `manually set **${boss.name}** kill time (from window)`,
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
    spawnWarnings[id] = { warned5: false, warned20: false, windowCreated: false };
    if (spawnWindowMessages[id]) {
      spawnWindowMessages[id].msg && spawnWindowMessages[id].msg.delete().catch(() => {});
      delete spawnWindowMessages[id];
      lastWindowOrder = [];
    }

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
      lastWindowOrder = [];
    }
    await clearEveryoneWarning(`${value}_5min`);
    await clearEveryoneWarning(`${value}_20min`);
    delete data.kills[value];
    spawnWarnings[value] = { warned5: false, warned20: false, windowCreated: false };
    save();
    log(interaction.user, `RESET timer for ${boss.name}`);
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
