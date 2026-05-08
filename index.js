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

// spawnWindowMessages: { [bossId]: { msg, windowEnd, boss, deleteTimer } }
// Ordered by insertion (Object.keys preserves insertion order in V8).
// Oldest entry = just below dashboard, newest = bottom of stack.
let spawnWindowMessages = {};

// everyoneWarnings: { [key]: { msg, content, repinTimer, deleteTimer } }
// Each @everyone warning repins itself every ~9 min and lives for 10 min total.
let everyoneWarnings = {};

let adminLogs  = [];
let undoStack  = [];

const MAX_DISCORD_BACKUPS = 7;
let backupMessages  = [];
let backupSlotIndex = 0;
let logMessage      = null;

// Repin the entire stack when REPIN_AFTER_MS has passed since the last repin.
const REPIN_AFTER_MS = 3 * 60 * 1000;
let lastRepinTime    = Date.now();

// @everyone warning lifespan = 10 minutes (same as before).
// It reposts itself 1 minute before expiry so it stays afloat.
const EVERYONE_WARNING_LIFESPAN_MS      = 10 * 60 * 1000;
const EVERYONE_REPIN_BEFORE_EXPIRE_MS   =  1 * 60 * 1000;

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

  const localEmpty = !fs.existsSync("data.json") ||
    Object.keys(JSON.parse(fs.readFileSync("data.json", "utf8")).kills || {}).length === 0;

  if (!localEmpty) {
    console.log("[Recovery] Local data.json exists — skipping Discord recovery.");
    return false;
  }

  console.log("[Recovery] No local data. Attempting Discord backup recovery...");
  try {
    const backupCh = await client.channels.fetch(DATA_BACKUP_CHANNEL_ID);
    const messages = await backupCh.messages.fetch({ limit: 50 });
    const backupMsg = messages.find(m =>
      m.author.id === client.user.id &&
      m.attachments.size > 0 &&
      [...m.attachments.values()].some(a => a.name && a.name.endsWith(".json"))
    );
    if (!backupMsg) { console.warn("[Recovery] No backup found."); return false; }

    const attachment = [...backupMsg.attachments.values()].find(a => a.name.endsWith(".json"));
    const response   = await fetch(attachment.url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const json = await response.json();
    if (!json.kills) throw new Error("No 'kills' in backup");

    data = json;
    save();
    console.log(`[Recovery] Restored ${Object.keys(data.kills).length} timer(s).`);
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
  for (let i = 1; i <= MAX_DISCORD_BACKUPS; i++) {
    const isoStamp = new Date().toISOString().replace(/:/g, "-").slice(0, 16);
    const msg = await backupChannel.send({
      embeds: [buildBackupEmbed(i, null)],
      files: [{ attachment: Buffer.from(JSON.stringify(data, null, 2), "utf8"), name: `backup-slot${i}-${isoStamp}.json` }],
      flags: MessageFlags.SuppressNotifications
    });
    backupMessages.push(msg);
  }
  console.log(`[Backup] ${MAX_DISCORD_BACKUPS} slots initialised.`);
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
  await channel.send({ content, flags: 4096 });
  forwardToLogChannel(content);
}

async function announceAdmin(channel, user, action) {
  const content = `📢 **${user.username}** ${action} — ${toServerDateTimeStr(Date.now())} (server time)`;
  const msg     = await channel.send({ content, flags: 4096 });
  setTimeout(() => { forwardToLogChannel(content); msg.delete().catch(() => {}); }, 10 * 60 * 1000);
}

async function forwardToLogChannel(content) {
  if (!LOG_CHANNEL_ID) return;
  try { await (await client.channels.fetch(LOG_CHANNEL_ID)).send({ content, flags: 4096 }); }
  catch (err) { console.error("[Log Channel]", err); }
}

// =====================
// @EVERYONE WARNINGS — self-repinning
//
// Posts the warning, then 1 minute before the 10-min lifespan expires it
// deletes the old message and posts a fresh one (keeping it at the bottom
// of chat). This repeats indefinitely until the boss is killed/reset or
// the spawn window closes — at which point clearEveryoneWarning() is called.
// =====================
async function postEveryoneWarning(channel, key, content) {
  await clearEveryoneWarning(key); // clean up any previous one for this key

  let msg;
  try { msg = await channel.send({ content }); }
  catch (err) { console.error("[Warning] Failed to post @everyone:", err); return; }

  forwardToLogChannel(content);
  scheduleEveryoneWarningCycle(channel, key, content, msg);
}

function scheduleEveryoneWarningCycle(channel, key, content, msg) {
  const repinDelay = EVERYONE_WARNING_LIFESPAN_MS - EVERYONE_REPIN_BEFORE_EXPIRE_MS; // 9 min

  const repinTimer = setTimeout(async () => {
    if (!everyoneWarnings[key]) return;
    everyoneWarnings[key].msg.delete().catch(() => {});

    let newMsg;
    try { newMsg = await channel.send({ content }); }
    catch { delete everyoneWarnings[key]; return; }

    everyoneWarnings[key].msg = newMsg;
    scheduleEveryoneWarningCycle(channel, key, content, newMsg);
  }, repinDelay);

  // Safety net: hard-delete after full lifespan in case repin failed
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

// =====================
// FLOATING STACK: repinStack()
//
// The stack order top-to-bottom in chat is:
//   [Log message]  ← posted once at startup, edited forever, never moves
//   [Dashboard]    ← repinned here
//   [Window A]     ← oldest active spawn window
//   [Window B]     ← next oldest
//   ...            ← newest at bottom
//
// repinStack() deletes and reposts the dashboard and all active spawn windows
// in the correct order. It is the single source of truth for the floating block.
//
// Call it when:
//   - Time-based repin fires (every 3 min)
//   - Dashboard message is found deleted (10008)
//   - A new spawn window is created (so it's posted in order below dashboard)
// =====================
async function repinStack(channel) {
  // 1. Delete current dashboard
  if (dashboardMessage) await dashboardMessage.delete().catch(() => {});
  dashboardMessage = null;

  // 2. Delete all active spawn window messages (repost in order below)
  for (const id of Object.keys(spawnWindowMessages)) {
    const w = spawnWindowMessages[id];
    if (w.msg) { w.msg.delete().catch(() => {}); w.msg = null; }
    // Clear the old delete timer — we'll set a fresh one after repost
    clearTimeout(w.deleteTimer);
    w.deleteTimer = null;
  }

  // 3. Repost dashboard
  dashboardMessage = await channel.send({
    embeds: [buildEmbed()],
    components: buildButtons(),
    flags: MessageFlags.SuppressNotifications
  });
  lastRepinTime = Date.now();

  // 4. Repost each spawn window in insertion order (oldest first = just below dashboard)
  const now = Date.now();
  for (const id of Object.keys(spawnWindowMessages)) {
    const w         = spawnWindowMessages[id];
    const hardExpiry = w.windowEnd + 15 * 60 * 1000; // window + 15 min grace

    if (hardExpiry <= now) {
      // Grace period fully expired — discard
      delete spawnWindowMessages[id];
      continue;
    }

    let newMsg;
    try {
      newMsg = await channel.send({
        embeds: [buildSpawnWindowEmbed(w.boss, w.windowEnd)],
        components: buildSpawnWindowComponents(id),
        flags: MessageFlags.SuppressNotifications
      });
    } catch (err) {
      console.error(`[Stack] Failed to repost window for ${id}:`, err);
      delete spawnWindowMessages[id];
      continue;
    }

    w.msg = newMsg;
    w.deleteTimer = setTimeout(() => {
      if (spawnWindowMessages[id]) {
        spawnWindowMessages[id].msg.delete().catch(() => {});
        delete spawnWindowMessages[id];
      }
    }, hardExpiry - now);
  }
}

// =====================
// CREATE SPAWN WINDOW
//
// Registers the new window entry then calls repinStack() so it's posted
// in the correct position (below all existing windows).
// =====================
async function createSpawnWindow(boss, id, channel, windowEnd) {
  if (spawnWindowMessages[id]) return; // already exists

  // Register placeholder — repinStack will fill in .msg and .deleteTimer
  spawnWindowMessages[id] = { msg: null, windowEnd, boss, deleteTimer: null };

  await repinStack(channel);
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
      text = `⚠️ Timer possibly wrong\n🕒 Last known respawn: ${toServerDateTimeStr(e.respawnTime)} (server)\n👤 ${e.lastKiller}`;
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
// MAIN LOOP
// =====================
function startLoop() {
  setInterval(async () => {
    if (!dashboardMessage) return;
    const channel = dashboardMessage.channel;

    // Time-based repin — repins whole stack to keep the block at the bottom of chat
    if (Date.now() - lastRepinTime >= REPIN_AFTER_MS) {
      await repinStack(channel);
      checkWarnings(channel);
      return;
    }

    // Edit dashboard in-place
    try {
      await dashboardMessage.edit({ embeds: [buildEmbed()], components: buildButtons() });
    } catch (err) {
      if (err.code === 10008) {
        // Dashboard was externally deleted — rebuild full stack
        await repinStack(channel);
        checkWarnings(channel);
        return;
      }
    }

    // Edit each spawn window in-place (always pass components to preserve buttons)
    for (const id of Object.keys(spawnWindowMessages)) {
      const w = spawnWindowMessages[id];
      if (!w.msg) continue;
      w.msg.edit({
        embeds: [buildSpawnWindowEmbed(w.boss, w.windowEnd)],
        components: buildSpawnWindowComponents(id)
      }).catch(err => {
        if (err.code === 10008) delete spawnWindowMessages[id];
      });
    }

    checkWarnings(channel);
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

    if (cooldown > 0 && cooldown <= 5 * 60 * 1000 && !w.warned5) {
      w.warned5 = true;
      postEveryoneWarning(channel, `${b.id}_5min`, `@everyone ⏳ **${b.name}** spawns in 5 minutes`);
    }

    if (cooldown <= 0 && windowLeft > 2 * 60 * 1000 && windowLeft <= 20 * 60 * 1000 && !w.warned20) {
      w.warned20 = true;
      postEveryoneWarning(channel, `${b.id}_20min`, `@everyone ⚠️ **${b.name}** may spawn in 20 minutes`);
    }

    if (cooldown <= 0 && windowLeft > 0 && !w.windowCreated) {
      w.windowCreated = true;
      createSpawnWindow(b, b.id, channel, windowEnd);
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

  await initLogMessage(channel); // posted first → stays highest, never repinned

  if (DATA_BACKUP_CHANNEL_ID) {
    try { await initBackupMessages(await client.channels.fetch(DATA_BACKUP_CHANNEL_ID)); }
    catch (err) { console.error("[Backup] Falling back to main channel:", err); await initBackupMessages(channel); }
  } else {
    await initBackupMessages(channel);
  }

  // Dashboard posted last → bottom of stack on startup
  dashboardMessage = await channel.send({
    embeds: [buildEmbed()],
    components: buildButtons(),
    flags: MessageFlags.SuppressNotifications
  });
  lastRepinTime = Date.now();

  startLoop();
  startBackupLoop();
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
      clearTimeout(spawnWindowMessages[id].deleteTimer);
      if (spawnWindowMessages[id].msg) spawnWindowMessages[id].msg.delete().catch(() => {});
      delete spawnWindowMessages[id];
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
      clearTimeout(spawnWindowMessages[id].deleteTimer);
      if (spawnWindowMessages[id].msg) spawnWindowMessages[id].msg.delete().catch(() => {});
      delete spawnWindowMessages[id];
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
        clearTimeout(spawnWindowMessages[id].deleteTimer);
        if (spawnWindowMessages[id].msg) spawnWindowMessages[id].msg.delete().catch(() => {});
        delete spawnWindowMessages[id];
      }
      for (const key of Object.keys(everyoneWarnings)) await clearEveryoneWarning(key);
      data.kills = {};
      save();
      log(interaction.user, `RESET ALL TIMERS`);
      await announceAdmin(interaction.channel, interaction.user, "reset **ALL** timers ☠️");
      return interaction.deferUpdate();
    }

    const boss = BOSSES.find(b => b.id === value);
    if (spawnWindowMessages[value]) {
      clearTimeout(spawnWindowMessages[value].deleteTimer);
      if (spawnWindowMessages[value].msg) spawnWindowMessages[value].msg.delete().catch(() => {});
      delete spawnWindowMessages[value];
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
