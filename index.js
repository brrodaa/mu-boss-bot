
const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Events,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle
} = require("discord.js");
 
const fs = require("fs");
const TOKEN = process.env.TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;
 
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages]
});
 
// =====================
// SETTINGS
// =====================
const TICK_RATE = 5000;
 
// =====================
// STATE (MERGED)
// =====================
let data = { bosses: {} };
let dashboardMessage = null;
let lastBackup = null;
 
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
const BOSSES_MAP = Object.fromEntries(BOSSES.map(b => [b.id, b]));
 
// =====================
// INIT
// =====================
function initBossData() {
  for (const b of BOSSES) {
    if (!data.bosses[b.id]) {
      data.bosses[b.id] = {
        lastKill: 0,
        respawnTime: 0,
        lastKiller: "",
        windowActive: false,
        history: []
      };
    }
  }
}
 
// =====================
// SAVE / LOAD
// =====================
function load() {
  if (fs.existsSync("data.json")) {
    data = JSON.parse(fs.readFileSync("data.json", "utf8"));
  }
  if (!data.bosses) data.bosses = {};
}
 
function save() {
  fs.writeFileSync("data.json.tmp", JSON.stringify(data, null, 2));
  fs.renameSync("data.json.tmp", "data.json");
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
// BACKUP
// =====================
function createBackup() {
  lastBackup = { time: Date.now(), data: JSON.parse(JSON.stringify(data)) };
}
 
function restoreBackup() {
  if (!lastBackup) return false;
  if (Date.now() - lastBackup.time > 8 * 60 * 60 * 1000) return false;
 
  data = JSON.parse(JSON.stringify(lastBackup.data));
  save();
  return true;
}
 
// =====================
// KILL SYSTEM (MERGED)
// =====================
function registerKill(id, user, type = "NORMAL") {
  const now = Date.now();
  const boss = data.bosses[id];
 
  boss.lastKill = now;
  boss.respawnTime = now + 7 * 60 * 60 * 1000;
  boss.lastKiller = user.username;
  boss.windowActive = false;
 
  boss.history.unshift({
    user: user.username,
    time: now,
    type
  });
 
  if (boss.history.length > 10) boss.history.pop();
 
  save();
}
 
// =====================
// SPAWN WINDOW
// =====================
async function createSpawnWindow(boss, id, channel) {
  const msg = await channel.send({
    embeds: [
      new EmbedBuilder()
        .setTitle(`⚠️ ${boss.name} MAY SPAWN`)
        .setColor(0xffcc00)
        .setDescription(`💀 Click if killed`)
    ],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId("window_kill_" + id)
          .setLabel("💀 Killed")
          .setStyle(ButtonStyle.Danger)
      )
    ]
  });
 
  setTimeout(() => {
    msg.delete().catch(() => {});
  }, 60 * 60 * 1000);
}
 
// =====================
// DASHBOARD
// =====================
function buildEmbed() {
  const now = Date.now();
 
  const embed = new EmbedBuilder()
    .setTitle("🔥 LIVE MU TRACKER")
    .setColor(0xffaa00)
    .setFooter({ text: "Auto-updates every 5s" });
 
  const bosses = BOSSES.map(b => {
    const e = data.bosses[b.id];
 
    const cooldown = e.respawnTime - now;
    const windowEnd = e.respawnTime + 60 * 60 * 1000;
    const windowLeft = windowEnd - now;
 
    let text;
    let isWindow = false;
 
    if (cooldown <= 0 && windowLeft > 0) {
      text = `🟢 WINDOW\n⏳ ${format(windowLeft)}\n👤 ${e.lastKiller}`;
      isWindow = true;
    } else if (windowLeft <= 0 && e.respawnTime > 0) {
      text = `⚠️ OUTDATED\n👤 ${e.lastKiller}`;
    } else {
      text =
        `🔴 ${format(cooldown)}\n` +
        `👤 ${e.lastKiller}`;
    }
 
    return {
      name: b.name,
      timeLeft: cooldown > 0 ? cooldown : windowLeft,
      text,
      isWindow
    };
  });
 
  bosses.sort((a, b) => a.timeLeft - b.timeLeft);
 
  for (const b of bosses) {
    embed.addFields({ name: b.name, value: b.text });
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
      new ButtonBuilder().setCustomId("restore_all").setLabel("↩️ Restore").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("show_logs").setLabel("📜 Logs").setStyle(ButtonStyle.Secondary)
    )
  );
 
  return rows;
}
 
// =====================
// LOOP
// =====================
function startLoop() {
  setInterval(async () => {
    if (!dashboardMessage) return;
 
    const channel = dashboardMessage.channel;
    const now = Date.now();
 
    await dashboardMessage.edit({
      embeds: [buildEmbed()],
      components: buildButtons()
    });
 
    for (const b of BOSSES) {
      const e = data.bosses[b.id];
      const cooldown = e.respawnTime - now;
      const windowEnd = e.respawnTime + 60 * 60 * 1000;
      const windowLeft = windowEnd - now;
 
      if (cooldown > 0 && cooldown <= 5 * 60 * 1000) {
        channel.send(`@everyone ⏳ ${b.name} in 5 minutes`);
      }
 
      if (cooldown <= 0 && windowLeft > 0 && !e.windowActive) {
        e.windowActive = true;
        createSpawnWindow(b, b.id, channel);
        save();
      }
    }
  }, TICK_RATE);
}
 
// =====================
// READY
// =====================
client.once("ready", async () => {
  console.log("Bot online");
 
  load();
  initBossData();
 
  const channel = await client.channels.fetch(config.channelId);
 
  dashboardMessage = await channel.send({
    embeds: [buildEmbed()],
    components: buildButtons()
  });
 
  startLoop();
});
 
// =====================
// INTERACTIONS
// =====================
client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isButton() && !interaction.isStringSelectMenu() && !interaction.isModalSubmit()) return;
 
  const now = Date.now();
 
  // =====================
  // KILL
  // =====================
  if (interaction.isButton() && interaction.customId.startsWith("kill_")) {
    const id = interaction.customId.replace("kill_", "");
 
    registerKill(id, interaction.user, "NORMAL");
 
    return interaction.reply({ content: "Recorded", ephemeral: true });
  }
 
  // =====================
  // WINDOW KILL
  // =====================
  if (interaction.isButton() && interaction.customId.startsWith("window_kill_")) {
    const id = interaction.customId.replace("window_kill_", "");
 
    registerKill(id, interaction.user, "WINDOW");
 
    data.bosses[id].windowActive = false;
    save();
 
    return interaction.reply({ content: "Window kill saved", ephemeral: true });
  }
 
  // =====================
  // INSERT
  // =====================
  if (interaction.customId === "insert_time") {
    const menu = new StringSelectMenuBuilder()
      .setCustomId("select_boss")
      .setPlaceholder("Select boss")
      .addOptions(BOSSES.map(b => ({ label: b.name, value: b.id })));
 
    return interaction.reply({
      content: "Select boss:",
      components: [new ActionRowBuilder().addComponents(menu)],
      ephemeral: true
    });
  }
 
  if (interaction.isStringSelectMenu() && interaction.customId === "select_boss") {
    const id = interaction.values[0];
 
    const modal = new ModalBuilder()
      .setCustomId("killtime_" + id)
      .setTitle("Insert Kill Time");
 
    const input = new TextInputBuilder()
      .setCustomId("time")
      .setLabel("HH:MM")
      .setStyle(TextInputStyle.Short);
 
    modal.addComponents(new ActionRowBuilder().addComponents(input));
 
    return interaction.showModal(modal);
  }
 
  if (interaction.isModalSubmit() && interaction.customId.startsWith("killtime_")) {
    const id = interaction.customId.replace("killtime_", "");
    const [h, m] = interaction.fields.getTextInputValue("time").split(":").map(Number);
 
    const kill = new Date();
    kill.setHours(h, m, 0, 0);
 
    registerKill(id, interaction.user, "MANUAL");
 
    data.bosses[id].lastKill = kill.getTime();
    data.bosses[id].respawnTime = kill.getTime() + 7 * 60 * 60 * 1000;
 
    save();
 
    return interaction.reply({ content: "Set saved", ephemeral: true });
  }
 
  // =====================
  // RESET
  // =====================
  if (interaction.customId === "reset_all") {
    createBackup();
    data.bosses = {};
    initBossData();
    save();
 
    return interaction.reply({ content: "Reset done", ephemeral: true });
  }
 
  // =====================
  // RESTORE
  // =====================
  if (interaction.customId === "restore_all") {
    const ok = restoreBackup();
    return interaction.reply({ content: ok ? "Restored" : "No backup", ephemeral: true });
  }
 
  // =====================
  // LOGS
  // =====================
  if (interaction.customId === "show_logs") {
    let desc = "";
 
    for (const b of BOSSES) {
      const h = data.bosses[b.id].history.slice(0, 3);
 
      desc += `**${b.name}**\n`;
      for (const x of h) {
        desc += `💀 ${x.user} • ${new Date(x.time).toLocaleTimeString()}\n`;
      }
      desc += "\n";
    }
 
    return interaction.reply({
      embeds: [new EmbedBuilder().setTitle("📜 Logs").setDescription(desc || "No data")],
      ephemeral: true
    });
  }
});
 
client.login(config.token);
