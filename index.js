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

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages]
});

/* =====================
   TIMEZONE FIX (ONLY CHANGE)
===================== */
function parseHHMMToTimestamp(h, m) {
  const now = new Date();

  return Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    h,
    m,
    0,
    0
  );
}

/* =====================
// SETTINGS
===================== */
const TICK_RATE = 5000;
const MAX_UNDO = 10;

/* =====================
// STATE
===================== */
let data = { kills: {} };
let dashboardMessage = null;

let spawnWarnings = {};
let spawnWindowMessages = {};
let adminLogs = [];
let undoStack = [];

/* =====================
// DASHBOARD RE-PIN
===================== */
const REPIN_AFTER_INTERACTIONS = 3;
const REPIN_AFTER_MS = 3 * 60 * 1000;
let interactionCount = 0;
let lastRepinTime = Date.now();

/* =====================
// BOSSES
===================== */
function buildBosses() {
  const bosses = [];
  for (let i = 1; i <= 3; i++) bosses.push({ id: `lorencia_${i}`, name: `Kharzul #${i}` });
  for (let i = 1; i <= 3; i++) bosses.push({ id: `davias_${i}`, name: `Vescrya #${i}` });
  for (let i = 1; i <= 2; i++) bosses.push({ id: `crywolf_${i}`, name: `Muggron #${i} Crywolf` });
  for (let i = 1; i <= 2; i++) bosses.push({ id: `barracks_${i}`, name: `Muggron #${i} Barracks` });
  return bosses;
}

const BOSSES = buildBosses();

/* =====================
// SAVE / LOAD
===================== */
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

/* =====================
// FORMAT
===================== */
function format(ms) {
  if (ms <= 0) return "NOW";
  const m = Math.floor(ms / 60000);
  const h = Math.floor(m / 60);
  const r = m % 60;
  return h > 0 ? `${h}h ${r}m` : `${m}m`;
}

/* =====================
// LOGGING
===================== */
function log(user, actionType) {
  adminLogs.unshift({
    user: user.username,
    action: actionType,
    time: Date.now()
  });
  if (adminLogs.length > 200) adminLogs.pop();
}

/* =====================
// UNDO
===================== */
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

/* =====================
// ANNOUNCE
===================== */
async function announce(channel, user, action, extra = "") {
  const ts = Math.floor(Date.now() / 1000);
  const msg = await channel.send(
    `📢 **${user.username}** ${action} — <t:${ts}:F>${extra ? `\n${extra}` : ""}`
  );

  setTimeout(() => msg.delete().catch(() => {}), 30 * 60 * 1000);
}

/* =====================
// SPAWN WINDOW
===================== */
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
}

/* =====================
// DASHBOARD
===================== */
function buildEmbed() {
  const now = Date.now();

  const embed = new EmbedBuilder()
    .setTitle("🔥 LIVE MU TRACKER")
    .setColor(0xffaa00)
    .setFooter({ text: "Auto-updates every 5s" });

  const bosses = BOSSES.map(b => {
    const e = data.kills[b.id];

    if (!e) {
      return {
        name: b.name,
        timeLeft: 0,
        text: "🟢 READY\n👤 None",
        isBroken: false
      };
    }

    const cooldown = e.respawnTime - now;
    const windowEnd = e.respawnTime + 60 * 60 * 1000;
    const windowLeft = windowEnd - now;

    let text;
    let isBroken = false;

    if (cooldown <= 0 && windowLeft > 0) {
      text = `🟢 WINDOW\n⏳ ${format(windowLeft)}\n👤 ${e.lastKiller}`;
    } else if (windowLeft <= 0) {
      text = `⚠️ Timer possibly wrong\n👤 ${e.lastKiller}`;
      isBroken = true;
    } else {
      const serverTime = new Date(e.respawnTime).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit"
      });

      text =
        `🔴 ${format(cooldown)}\n` +
        `🕒 ServerTime: ${serverTime}\n` +
        `👤 ${e.lastKiller}`;
    }

    return {
      name: b.name,
      timeLeft: Math.max(cooldown, windowLeft),
      text,
      isBroken
    };
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

/* =====================
// INTERACTIONS (ONLY TIME FIX PART CHANGED)
===================== */
client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isButton() && !interaction.isStringSelectMenu() && !interaction.isModalSubmit()) return;

  /* WINDOW SET TIME */
  if (interaction.isModalSubmit() && interaction.customId.startsWith("window_killtime_")) {
    snapshot();

    const id = interaction.customId.replace("window_killtime_", "");
    const boss = BOSSES.find(b => b.id === id);
    const [h, m] = interaction.fields.getTextInputValue("time").split(":").map(Number);

    const killTime = parseHHMMToTimestamp(h, m);
    const kill = new Date(killTime);

    const respawnTime = killTime + 7 * 60 * 60 * 1000;

    data.kills[id] = {
      killTime,
      respawnTime,
      lastKiller: interaction.user.username
    };

    save();
    return interaction.deferUpdate();
  }

  /* INSERT TIME */
  if (interaction.isModalSubmit() && interaction.customId.startsWith("killtime_")) {
    snapshot();

    const id = interaction.customId.replace("killtime_", "");
    const boss = BOSSES.find(b => b.id === id);
    const [h, m] = interaction.fields.getTextInputValue("time").split(":").map(Number);

    const killTime = parseHHMMToTimestamp(h, m);
    const kill = new Date(killTime);

    const respawnTime = killTime + 7 * 60 * 60 * 1000;

    data.kills[id] = {
      killTime,
      respawnTime,
      lastKiller: interaction.user.username
    };

    save();
    return interaction.deferUpdate();
  }
});

/* =====================
// START
===================== */
client.once(Events.ClientReady, async () => {
  console.log("Bot online");
  load();

  const channel = await client.channels.fetch(process.env.CHANNEL_ID);

  dashboardMessage = await channel.send({
    embeds: [buildEmbed()],
    components: [],
    flags: MessageFlags.SuppressNotifications
  });
});

client.login(process.env.TOKEN);
