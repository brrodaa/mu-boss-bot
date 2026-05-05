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

// =====================
// SETTINGS
// =====================
const TICK_RATE = 5000;
const MAX_UNDO = 10;

// =====================
// STATE
// =====================
let data = { kills: {} };
let dashboardMessage = null;

let spawnWarnings = {};
let spawnWindowMessages = {};
let adminLogs = [];
let undoStack = [];

// =====================
// BOSSES
// =====================
function buildBosses() {
  const bosses = [];
  for (let i = 1; i <= 3; i++) bosses.push({ id: `lorencia_${i}`, name: `Kharzul #${i}` });
  for (let i = 1; i <= 3; i++) bosses.push({ id: `davias_${i}`, name: `Vescrya #${i}` });
  for (let i = 1; i <= 2; i++) bosses.push({ id: `crywolf_${i}`, name: `Muggron #${i} Crywolf` });
  for (let i = 1; i <= 2; i++) bosses.push({ id: `barracks_${i}`, name: `Muggron #${i} Barracks` });
  return bosses;
}

const BOSSES = buildBosses();

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
// TIME FORMAT
// =====================
function format(ms) {
  if (ms <= 0) return "NOW";
  const m = Math.floor(ms / 60000);
  const h = Math.floor(m / 60);
  const r = m % 60;
  return h > 0 ? `${h}h ${r}m` : `${m}m`;
}

// =====================
// TIME PARSER (WARSAW SHARED TIME)
// =====================
function parseTime(h, m) {
  const now = new Date();
  const d = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    h,
    m,
    0,
    0
  );

  if (d.getTime() > Date.now()) {
    d.setDate(d.getDate() - 1);
  }

  return d.getTime();
}

// =====================
// EMBED
// =====================
function buildEmbed() {
  const now = Date.now();

  const embed = new EmbedBuilder()
    .setTitle("🔥 LIVE MU TRACKER")
    .setColor(0xffaa00);

  for (const b of BOSSES) {
    const e = data.kills[b.id];

    if (!e) {
      embed.addFields({ name: b.name, value: "🟢 READY\n👤 None" });
      continue;
    }

    const cooldown = e.respawnTime - now;
    const windowEnd = e.respawnTime + 60 * 60 * 1000;
    const windowLeft = windowEnd - now;

    let text;

    if (cooldown <= 0 && windowLeft > 0) {
      text = `🟢 WINDOW\n⏳ ${format(windowLeft)}\n👤 ${e.lastKiller}`;
    } else {
      text = `🔴 ${format(cooldown)}\n👤 ${e.lastKiller}`;
    }

    embed.addFields({ name: b.name, value: text });
  }

  return embed;
}

// =====================
// BUTTONS
// =====================
function buildButtons() {
  const rows = [];

  for (let i = 0; i < BOSSES.length; i += 5) {
    const row = new ActionRowBuilder();

    BOSSES.slice(i, i + 5).forEach(b => {
      row.addComponents(
        new ButtonBuilder()
          .setCustomId("kill_" + b.id)
          .setLabel(b.name.slice(0, 20))
          .setStyle(ButtonStyle.Primary)
      );
    });

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
// DASHBOARD RELOAD
// =====================
async function repin(channel) {
  if (dashboardMessage) {
    await dashboardMessage.delete().catch(() => {});
  }

  dashboardMessage = await channel.send({
    embeds: [buildEmbed()],
    components: buildButtons(),
    flags: MessageFlags.SuppressNotifications
  });
}

// =====================
// READY
// =====================
client.once(Events.ClientReady, async () => {
  console.log("Bot online");
  load();

  const channel = await client.channels.fetch(process.env.CHANNEL_ID);

  await repin(channel);
});

// =====================
// INTERACTIONS
// =====================
client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isButton() && !interaction.isModalSubmit()) return;

  // =====================
  // KILL BUTTON
  // =====================
  if (interaction.isButton() && interaction.customId.startsWith("kill_")) {
    const id = interaction.customId.replace("kill_", "");
    const boss = BOSSES.find(b => b.id === id);

    const now = Date.now();
    const respawn = now + 7 * 60 * 60 * 1000;

    data.kills[id] = {
      killTime: now,
      respawnTime: respawn,
      lastKiller: interaction.user.username
    };

    save();

    return interaction.deferUpdate();
  }

  // =====================
  // INSERT MENU
  // =====================
  if (interaction.isButton() && interaction.customId === "insert_time") {
    const menu = new StringSelectMenuBuilder()
      .setCustomId("select_boss")
      .setPlaceholder("Select boss")
      .addOptions(BOSSES.map(b => ({ label: b.name, value: b.id })));

    return interaction.reply({
      components: [new ActionRowBuilder().addComponents(menu)],
      flags: MessageFlags.Ephemeral
    });
  }

  // =====================
  // SELECT BOSS
  // =====================
  if (interaction.isStringSelectMenu() && interaction.customId === "select_boss") {
    const id = interaction.values[0];

    const modal = new ModalBuilder()
      .setCustomId("killtime_" + id)
      .setTitle("Insert Time");

    const input = new TextInputBuilder()
      .setCustomId("time")
      .setLabel("HH:MM")
      .setStyle(TextInputStyle.Short);

    modal.addComponents(new ActionRowBuilder().addComponents(input));

    return interaction.showModal(modal);
  }

  // =====================
  // MODAL SUBMIT
  // =====================
  if (interaction.isModalSubmit() && interaction.customId.startsWith("killtime_")) {
    const id = interaction.customId.replace("killtime_", "");
    const [h, m] = interaction.fields.getTextInputValue("time").split(":").map(Number);

    const kill = parseTime(h, m);
    const respawn = kill + 7 * 60 * 60 * 1000;

    data.kills[id] = {
      killTime: kill,
      respawnTime: respawn,
      lastKiller: interaction.user.username
    };

    save();

    return interaction.deferUpdate();
  }
});

// =====================
// LOOP
// =====================
setInterval(async () => {
  if (!dashboardMessage) return;

  await dashboardMessage.edit({
    embeds: [buildEmbed()],
    components: buildButtons()
  });
}, TICK_RATE);

// =====================
client.login(process.env.TOKEN);
