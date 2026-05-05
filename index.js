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
client.login(process.env.BOT_TOKEN);

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

const REPIN_AFTER_INTERACTIONS = 3;
const REPIN_AFTER_MS = 3 * 60 * 1000;
let interactionCount = 0;
let lastRepinTime = Date.now();

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
// TIMEZONE HELPER
// =====================
const SERVER_TZ = "Europe/Amsterdam";

function getAmsterdamOffsetMs(date) {
  const utcStr = date.toLocaleString("en-US", { timeZone: "UTC" });
  const tzStr  = date.toLocaleString("en-US", { timeZone: SERVER_TZ });
  return new Date(tzStr) - new Date(utcStr);
}

function parseServerTime(h, m) {
  const now = new Date();
  const dateStr = now.toLocaleDateString("en-CA", { timeZone: SERVER_TZ });
  const candidate = new Date(`${dateStr}T${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}:00`);
  const tzOffset = getAmsterdamOffsetMs(candidate);
  const utcMs = candidate.getTime() - tzOffset;
  const kill = new Date(utcMs);
  if (kill > now) kill.setDate(kill.getDate() - 1);
  return kill;
}

// Format a UTC timestamp as HH:MM in server timezone (24h)
function toServerTimeStr(ms) {
  return new Date(ms).toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: SERVER_TZ,
    hour12: false
  });
}

// Format a UTC timestamp as HH:MM:SS DD/MM/YYYY in server timezone (24h) — for logs
function toServerDateTimeStr(ms) {
  const d = new Date(ms);
  return d.toLocaleString("en-GB", {
    timeZone: SERVER_TZ,
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    day: "2-digit",
    month: "2-digit",
    year: "numeric"
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
  adminLogs.unshift({
    user: user.username,
    action: actionType,
    time: Date.now()
  });
  if (adminLogs.length > 200) adminLogs.pop();
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
// PUBLIC ANNOUNCE HELPER
// =====================
async function announce(channel, user, action, extra = "") {
  const ts = Math.floor(Date.now() / 1000);
  const msg = await channel.send(
    `📢 **${user.username}** ${action} — <t:${ts}:F>${extra ? `\n${extra}` : ""}`
  );
  setTimeout(() => msg.delete().catch(() => {}), 30 * 60 * 1000);
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

  const msUntilExpiry = windowEnd - Date.now();
  const deleteAfter = msUntilExpiry + 15 * 60 * 1000;
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
// DASHBOARD EMBED
// =====================
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
      const lastKnown = `<t:${Math.floor(e.respawnTime / 1000)}:F>`;
      text = `⚠️ Timer possibly wrong\n🕒 Last known respawn: ${lastKnown}\n👤 ${e.lastKiller}`;
      isBroken = true;
    } else {
      const tsRespawn = Math.floor(e.respawnTime / 1000);
      const serverTime = toServerTimeStr(e.respawnTime);
      text =
        `🔴 ${format(cooldown)}\n` +
        `🕒 Server time: ${serverTime} — Your time: <t:${tsRespawn}:t>\n` +
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
  try {
    if (dashboardMessage) await dashboardMessage.delete().catch(() => {});
  } catch (_) {}

  dashboardMessage = await channel.send({
    embeds: [buildEmbed()],
    components: buildButtons(),
    flags: MessageFlags.SuppressNotifications
  });

  interactionCount = 0;
  lastRepinTime = Date.now();

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
        return;
      }
    }

    const now = Date.now();

    for (const id in spawnWindowMessages) {
      const w = spawnWindowMessages[id];
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

    const cooldown = e.respawnTime - now;
    const windowEnd = e.respawnTime + 60 * 60 * 1000;
    const windowLeft = windowEnd - now;

    if (!spawnWarnings[b.id]) {
      spawnWarnings[b.id] = { warned5: false, warned20: false, windowCreated: false };
    }

    const w = spawnWarnings[b.id];

    if (cooldown > 0 && cooldown <= 5 * 60 * 1000 && !w.warned5) {
      w.warned5 = true;
      channel.send(`@everyone ⏳ **${b.name}** spawns in 5 minutes`);
    }

    if (
      cooldown <= 0 &&
      windowLeft > 2 * 60 * 1000 &&
      windowLeft <= 20 * 60 * 1000 &&
      !w.warned20
    ) {
      w.warned20 = true;
      channel.send(`@everyone ⚠️ **${b.name}** may spawn in 20 minutes`);
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

  const channel = await client.channels.fetch(config.channelId);

  dashboardMessage = await channel.send({
    embeds: [buildEmbed()],
    components: buildButtons(),
    flags: MessageFlags.SuppressNotifications
  });

  startLoop();
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

    const id = interaction.customId.replace("kill_", "");
    const boss = BOSSES.find(b => b.id === id);
    const now = Date.now();
    const respawnTime = now + 7 * 60 * 60 * 1000;

    data.kills[id] = {
      killTime: now,
      respawnTime,
      lastKiller: interaction.user.username
    };

    save();
    log(interaction.user, `KILLED ${boss.name} — kill: ${toServerDateTimeStr(now)} — respawn: ${toServerDateTimeStr(respawnTime)}`);

    spawnWarnings[id] = { warned5: false, warned20: false, windowCreated: false };

    const tsKill = Math.floor(now / 1000);
    const tsRespawn = Math.floor(respawnTime / 1000);

    await announce(
      interaction.channel,
      interaction.user,
      `killed **${boss.name}**`,
      `🕒 Kill: <t:${tsKill}:F> — 🔄 Respawn: <t:${tsRespawn}:F>`
    );

    return interaction.deferUpdate();
  }

  // =====================
  // WINDOW KILL
  // =====================
  if (interaction.isButton() && interaction.customId.startsWith("window_kill_")) {
    snapshot();

    const id = interaction.customId.replace("window_kill_", "");
    const boss = BOSSES.find(b => b.id === id);
    const now = Date.now();
    const respawnTime = now + 7 * 60 * 60 * 1000;

    if (spawnWindowMessages[id]) {
      spawnWindowMessages[id].msg.delete().catch(() => {});
      delete spawnWindowMessages[id];
    }

    data.kills[id] = {
      killTime: now,
      respawnTime,
      lastKiller: interaction.user.username
    };

    save();
    log(interaction.user, `WINDOW KILL ${boss.name} — kill: ${toServerDateTimeStr(now)} — respawn: ${toServerDateTimeStr(respawnTime)}`);

    spawnWarnings[id] = { warned5: false, warned20: false, windowCreated: false };

    const tsKill = Math.floor(now / 1000);
    const tsRespawn = Math.floor(respawnTime / 1000);

    await announce(
      interaction.channel,
      interaction.user,
      `killed **${boss.name}** (window kill)`,
      `🕒 Kill: <t:${tsKill}:F> — 🔄 Respawn: <t:${tsRespawn}:F>`
    );

    return interaction.deferUpdate();
  }

  // =====================
  // WINDOW SET TIME — show modal
  // =====================
  if (interaction.isButton() && interaction.customId.startsWith("window_settime_")) {
    const id = interaction.customId.replace("window_settime_", "");
    const boss = BOSSES.find(b => b.id === id);

    log(interaction.user, `Opened set-time modal for ${boss.name} (window)`);

    const modal = new ModalBuilder()
      .setCustomId("window_killtime_" + id)
      .setTitle(`Set Kill Time — ${boss.name}`);

    const input = new TextInputBuilder()
      .setCustomId("time")
      .setLabel("HH:MM (24h, server time)")
      .setStyle(TextInputStyle.Short);

    modal.addComponents(new ActionRowBuilder().addComponents(input));

    return interaction.showModal(modal);
  }

  // WINDOW SET TIME — modal submit
  if (interaction.isModalSubmit() && interaction.customId.startsWith("window_killtime_")) {
    snapshot();

    const id = interaction.customId.replace("window_killtime_", "");
    const boss = BOSSES.find(b => b.id === id);
    const timeValue = interaction.fields.getTextInputValue("time");
    const [h, m] = timeValue.split(":").map(Number);

    const kill = parseServerTime(h, m);
    const respawnTime = kill.getTime() + 7 * 60 * 60 * 1000;

    if (spawnWindowMessages[id]) {
      spawnWindowMessages[id].msg.delete().catch(() => {});
      delete spawnWindowMessages[id];
    }

    data.kills[id] = {
      killTime: kill.getTime(),
      respawnTime,
      lastKiller: interaction.user.username
    };

    save();
    log(interaction.user, `MANUAL SET (window) ${boss.name} — kill: ${toServerDateTimeStr(kill.getTime())} — respawn: ${toServerDateTimeStr(respawnTime)}`);

    spawnWarnings[id] = { warned5: false, warned20: false, windowCreated: false };

    const tsKill = Math.floor(kill.getTime() / 1000);
    const tsRespawn = Math.floor(respawnTime / 1000);

    await announce(
      interaction.channel,
      interaction.user,
      `manually set **${boss.name}** kill time (from window)`,
      `🕒 Kill: <t:${tsKill}:F> — 🔄 Respawn: <t:${tsRespawn}:F>`
    );

    return interaction.deferUpdate();
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
      content: "📝 Select boss to insert kill time:",
      components: [new ActionRowBuilder().addComponents(menu)],
      flags: MessageFlags.Ephemeral
    });
  }

  // INSERT TIME — step 2: pick timezone mode
  if (interaction.isStringSelectMenu() && interaction.customId === "select_boss_insert") {
    const id = interaction.values[0];
    const boss = BOSSES.find(b => b.id === id);

    log(interaction.user, `Insert: selected boss ${boss.name}, showing timezone choice`);

    const menu = new StringSelectMenuBuilder()
      .setCustomId("select_tzmode_" + id)
      .setPlaceholder("Which time format will you enter?")
      .addOptions([
        {
          label: "🌍 Server time (HH:MM, 24h)",
          description: "Enter the kill time in server timezone",
          value: "server"
        },
        {
          label: "🏠 My local time (HH:MM, 24h)",
          description: "Enter the kill time in your own timezone",
          value: "local"
        }
      ]);

    return interaction.reply({
      content: `⏱️ How will you enter the kill time for **${boss.name}**?`,
      components: [new ActionRowBuilder().addComponents(menu)],
      flags: MessageFlags.Ephemeral
    });
  }

  // INSERT TIME — step 3: show modal based on chosen mode
  if (interaction.isStringSelectMenu() && interaction.customId.startsWith("select_tzmode_")) {
    const id = interaction.customId.replace("select_tzmode_", "");
    const boss = BOSSES.find(b => b.id === id);
    const mode = interaction.values[0]; // "server" or "local"

    log(interaction.user, `Insert: ${boss.name} — chose ${mode} time input`);

    const label = mode === "server"
      ? "HH:MM (24h, server time)"
      : "HH:MM (24h, your local time)";

    const modal = new ModalBuilder()
      .setCustomId(`killtime_${mode}_${id}`)
      .setTitle(`Insert Kill Time — ${boss.name}`);

    const input = new TextInputBuilder()
      .setCustomId("time")
      .setLabel(label)
      .setStyle(TextInputStyle.Short);

    modal.addComponents(new ActionRowBuilder().addComponents(input));

    return interaction.showModal(modal);
  }

  // INSERT TIME — step 4: save (server time mode)
  if (interaction.isModalSubmit() && interaction.customId.startsWith("killtime_server_")) {
    snapshot();

    const id = interaction.customId.replace("killtime_server_", "");
    const boss = BOSSES.find(b => b.id === id);
    const timeValue = interaction.fields.getTextInputValue("time");
    const [h, m] = timeValue.split(":").map(Number);

    const kill = parseServerTime(h, m);
    const respawnTime = kill.getTime() + 7 * 60 * 60 * 1000;

    data.kills[id] = {
      killTime: kill.getTime(),
      respawnTime,
      lastKiller: interaction.user.username
    };

    save();
    log(interaction.user, `MANUAL SET (server time) ${boss.name} — kill: ${toServerDateTimeStr(kill.getTime())} — respawn: ${toServerDateTimeStr(respawnTime)}`);

    spawnWarnings[id] = { warned5: false, warned20: false, windowCreated: false };

    const tsKill = Math.floor(kill.getTime() / 1000);
    const tsRespawn = Math.floor(respawnTime / 1000);

    await announce(
      interaction.channel,
      interaction.user,
      `manually set **${boss.name}** kill time`,
      `🕒 Kill: <t:${tsKill}:F> — 🔄 Respawn: <t:${tsRespawn}:F>`
    );

    return interaction.deferUpdate();
  }

  // INSERT TIME — step 4: save (local time mode)
  if (interaction.isModalSubmit() && interaction.customId.startsWith("killtime_local_")) {
    snapshot();

    const id = interaction.customId.replace("killtime_local_", "");
    const boss = BOSSES.find(b => b.id === id);
    const timeValue = interaction.fields.getTextInputValue("time");
    const [h, m] = timeValue.split(":").map(Number);

    // Treat input as the bot host's local time (i.e. what the user typed as-is)
    // Discord doesn't expose the user's timezone, so we parse it as local wall clock
    const now = new Date();
    const kill = new Date(now);
    kill.setHours(h, m, 0, 0);
    if (kill > now) kill.setDate(kill.getDate() - 1);

    const respawnTime = kill.getTime() + 7 * 60 * 60 * 1000;

    data.kills[id] = {
      killTime: kill.getTime(),
      respawnTime,
      lastKiller: interaction.user.username
    };

    save();
    log(interaction.user, `MANUAL SET (local time input) ${boss.name} — kill: ${toServerDateTimeStr(kill.getTime())} — respawn: ${toServerDateTimeStr(respawnTime)}`);

    spawnWarnings[id] = { warned5: false, warned20: false, windowCreated: false };

    const tsKill = Math.floor(kill.getTime() / 1000);
    const tsRespawn = Math.floor(respawnTime / 1000);

    await announce(
      interaction.channel,
      interaction.user,
      `manually set **${boss.name}** kill time (local time)`,
      `🕒 Kill: <t:${tsKill}:F> — 🔄 Respawn: <t:${tsRespawn}:F>`
    );

    return interaction.deferUpdate();
  }

  // =====================
  // RESET — step 1: show dropdown
  // =====================
  if (interaction.isButton() && interaction.customId === "reset_all") {
    log(interaction.user, `Opened reset selection menu`);

    const menu = new StringSelectMenuBuilder()
      .setCustomId("reset_select")
      .setPlaceholder("Select what to reset")
      .addOptions([
        ...BOSSES.map(b => ({
          label: `Reset ${b.name}`,
          value: b.id
        })),
        {
          label: "☠️ DELETE ALL TIMERS (Server Reset)",
          value: "DELETE_ALL"
        }
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
      log(interaction.user, `RESET ALL TIMERS`);

      await announce(interaction.channel, interaction.user, "reset **ALL** timers ☠️");

      return interaction.deferUpdate();
    }

    const boss = BOSSES.find(b => b.id === value);
    delete data.kills[value];

    spawnWarnings[value] = { warned5: false, warned20: false, windowCreated: false };

    save();
    log(interaction.user, `RESET timer for ${boss.name}`);

    await announce(interaction.channel, interaction.user, `reset timer for **${boss.name}**`);

    return interaction.deferUpdate();
  }

  // =====================
  // UNDO
  // =====================
  if (interaction.isButton() && interaction.customId === "undo") {
    const ok = undo();
    log(interaction.user, ok ? `UNDO success` : `UNDO failed — nothing to undo`);

    await announce(
      interaction.channel,
      interaction.user,
      ok ? "used **Undo** ↩️" : "tried to undo — nothing to undo"
    );

    return interaction.deferUpdate();
  }

  // =====================
  // LOGS
  // =====================
  if (interaction.isButton() && interaction.customId === "show_logs") {
    log(interaction.user, `Viewed logs`);

    const recent = adminLogs.slice(0, 20);

    let description = "";
    for (const l of recent) {
      description += `\`${toServerDateTimeStr(l.time)}\` — **${l.user}** — ${l.action}\n`;
    }

    if (!description) description = "No actions logged yet.";

    const embed = new EmbedBuilder()
      .setTitle("📜 Action Log (Last 20)")
      .setDescription(description)
      .setColor(0x5865f2);

    return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  }
});

client.login(process.env.DISCORD_TOKEN);
