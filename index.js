import "dotenv/config";
import { Client } from "discord.js-selfbot-v13";
import http from "http";
import fs from "fs/promises";
import path from "path";

const cfg = {
  token: process.env.TOKEN,
  logChannelId: process.env.CHANNEL_ID,
  guildId: process.env.GUILD_ID,
  pollInterval: parseInt(process.env.POLL_INTERVAL || "60000", 10), // default 60s
  persistenceFile: path.resolve(process.cwd(), "knownMembers.json"),
  notifyDebounceMs: 5_000, // batch sends that occur within this window
  notifyCooldownMs: 10 * 60 * 1000 // don't notify about same user within 10 mins
};

const client = new Client();
const knownMembers = {}; // { guildId: Set(memberIds) }
const lastNotified = new Map(); // memberId => timestamp (ms)
let notifyBuffer = []; // array of {guild, member}
let debounceTimer = null;
let saveScheduled = false;

// ---------------------------
// Helper: format detailed join log
// ---------------------------
function formatJoinLog(member) {
  const user = member.user;
  // Display tag (safe)
  const displayTag =
    (user.tag && user.tag !== "undefined#undefined")
      ? user.tag
      : `${user.username}#${user.discriminator || "0000"}`;

  // timestamps
  const createdDate = user.createdTimestamp
    ? `<t:${Math.floor(user.createdTimestamp / 1000)}:F> (<t:${Math.floor(user.createdTimestamp / 1000)}:R>)`
    : "Unknown";

  const joinedDate = member.joinedTimestamp
    ? `<t:${Math.floor(member.joinedTimestamp / 1000)}:F>`
    : "Unknown";

  const guild = member.guild;
  const nickname = member.nickname || "None";
  const pending = member.pending ? "Yes" : "No";

  // boost / premium
  let boostingSince = "Not Boosting";
  try {
    // v13 may have premiumSince or premiumSinceTimestamp
    if (member.premiumSince) {
      const t = member.premiumSince instanceof Date ? member.premiumSince.getTime() : member.premiumSince;
      boostingSince = `<t:${Math.floor(t / 1000)}:F>`;
    } else if (member.premiumSinceTimestamp) {
      boostingSince = `<t:${Math.floor(member.premiumSinceTimestamp / 1000)}:F>`;
    }
  } catch (e) {
    boostingSince = "Not Boosting";
  }

  // timeout / communication disabled
  let timedOutUntil = "No Timeout";
  try {
    if (member.communicationDisabledUntilTimestamp) {
      timedOutUntil = `<t:${Math.floor(member.communicationDisabledUntilTimestamp / 1000)}:F>`;
    } else if (member.communicationDisabledUntil) {
      const t = member.communicationDisabledUntil instanceof Date ? member.communicationDisabledUntil.getTime() : member.communicationDisabledUntil;
      timedOutUntil = `<t:${Math.floor(t / 1000)}:F>`;
    }
  } catch (e) {
    timedOutUntil = "No Timeout";
  }

  // roles
  const roles = Array.from(member.roles.cache.values()).filter(r => r && r.id !== guild.id);
  const rolesCount = roles.length;
  const highestRole = rolesCount ? roles.sort((a, b) => b.position - a.position)[0] : null;
  const roleNames = roles.map(r => r.name);

  // avatar & banner
  let avatarUrl = null;
  try {
    avatarUrl = user.displayAvatarURL ? user.displayAvatarURL({ size: 1024, dynamic: true }) : null;
  } catch (e) {
    avatarUrl = null;
  }
  let bannerUrl = null;
  try {
    // user.bannerURL may not exist in v13; try safely
    if (typeof user.bannerURL === "function") bannerUrl = user.bannerURL({ size: 1024, dynamic: true });
    else bannerUrl = null;
  } catch (e) {
    bannerUrl = null;
  }

  // flags / badges
  let flagsArr = [];
  try {
    if (user.flags && typeof user.flags.toArray === "function") flagsArr = user.flags.toArray();
  } catch (e) {
    flagsArr = [];
  }

  const lines = [
    `📥 **Member Joined**`,
    "```ini",
    "[User]",
    `Username = ${displayTag}`,
    `Mention = <@${user.id}>`,
    `ID = ${user.id}`,
    `Bot = ${user.bot ? "Yes" : "No"}`,
    `System = ${user.system ? "Yes" : "No"}`,
    "",
    "[Account Info]",
    `Created = ${createdDate}`,
    `Joined Server = ${joinedDate}`,
    "",
    "[Server Details]",
    `Guild = ${guild.name} (${guild.id})`,
    `Nickname = ${nickname}`,
    `Pending Screening = ${pending}`,
    `Boosting Since = ${boostingSince}`,
    `Timeout Until = ${timedOutUntil}`,
    "",
    "[Roles]",
    `Total Count = ${rolesCount}`,
    rolesCount ? `Top Role = ${highestRole.name} (${highestRole.id})` : null,
    roleNames.length ? `Role List = ${roleNames.join(", ")}` : null,
    "",
    "[Media]",
    avatarUrl ? `Avatar = Available` : `Avatar = None`,
    bannerUrl ? `Banner = Available` : `Banner = None`,
    `Badges/Flags = ${flagsArr.length ? flagsArr.join(", ") : "None"}`,
    "```",
    "",
    `**Username:** \`\`\`${displayTag}\`\`\``,
    avatarUrl ? `**Avatar:** ${avatarUrl}` : null,
    bannerUrl ? `**Banner:** ${bannerUrl}` : null
  ].filter(Boolean);

  return lines.join("\n");
}

// ---------------------------
// helper: load persistence
// returns true if a persistence file existed and was loaded, false if not found
// ---------------------------
async function loadPersistence() {
  try {
    const raw = await fs.readFile(cfg.persistenceFile, "utf8");
    const obj = JSON.parse(raw);
    for (const guildId of Object.keys(obj || {})) {
      knownMembers[guildId] = new Set(obj[guildId]);
    }
    console.log("Loaded known members from disk.");
    return true;
  } catch (err) {
    if (err && err.code === "ENOENT") {
      console.log("No persistence file found; starting fresh.");
      return false;
    }
    console.warn("Failed to load persistence (corrupt or other):", err);
    // If the file exists but is corrupt, we ignore it and start fresh
    return false;
  }
}

// ---------------------------
// helper: save persistence (debounced simple)
// ---------------------------
async function savePersistence() {
  // debounce: schedule write only once per short window
  if (saveScheduled) return;
  saveScheduled = true;

  setTimeout(async () => {
    const dump = {};
    for (const gid of Object.keys(knownMembers)) {
      try {
        dump[gid] = Array.from(knownMembers[gid]);
      } catch (e) {
        dump[gid] = [];
      }
    }
    try {
      await fs.writeFile(cfg.persistenceFile, JSON.stringify(dump, null, 2), "utf8");
      // console.log("Saved persistence to disk.");
    } catch (err) {
      console.warn("Failed to save persistence:", err);
    } finally {
      saveScheduled = false;
    }
  }, 800);
}

// helper: find new members by comparing sets
function diffNewMembers(guildId, fetchedMembers) {
  const seen = knownMembers[guildId] || new Set();
  const newOnes = [];
  for (const [id, member] of fetchedMembers) {
    if (!seen.has(id)) newOnes.push(member);
  }
  return newOnes;
}

// ---------------------------
// flush notify buffer grouped by guild
// uses detailed format for each member (same as instant)
// ---------------------------
async function flushNotifyBuffer() {
  if (!notifyBuffer.length) return;
  const byGuild = new Map();
  for (const item of notifyBuffer) {
    const g = item.guild.id;
    if (!byGuild.has(g)) byGuild.set(g, []);
    byGuild.get(g).push(item.member);
  }
  notifyBuffer = [];

  for (const [guildId, members] of byGuild.entries()) {
    try {
      const channel = await client.channels.fetch(cfg.logChannelId);
      if (!channel) {
        console.warn("Log channel fetch failed.");
        continue;
      }

      // send each member as a separate detailed message to match instant format
      for (const m of members) {
        try {
          const msg = formatJoinLog(m);
          await channel.send(msg);
        } catch (err) {
          console.warn("Failed to send formatted member message:", err);
        }
      }

      console.log(`Sent join notification for ${members.length} members (guild ${guildId})`);
    } catch (err) {
      console.warn("Failed to send notification:", err);
    }
  }
}

async function scheduleNotify(member, guild) {
  const last = lastNotified.get(member.id) || 0;
  if (Date.now() - last < cfg.notifyCooldownMs) return;
  lastNotified.set(member.id, Date.now());

  notifyBuffer.push({ guild, member });

  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    flushNotifyBuffer().catch((e) => console.warn("Flush error:", e));
  }, cfg.notifyDebounceMs);
}

// core polling worker
async function pollWorker() {
  for (const [guildId, guild] of client.guilds.cache) {
    try {
      if (!knownMembers[guildId]) knownMembers[guildId] = new Set();

      const currentKnownSize = knownMembers[guildId].size;
      const remoteCount = guild.memberCount || 0;

      if (remoteCount <= currentKnownSize) {
        continue;
      }

      let fetched;
      try {
        fetched = await guild.members.fetch();
      } catch (err) {
        console.warn(`Failed guild.members.fetch() for ${guild.name}:`, err?.message || err);
        fetched = guild.members.cache;
      }

      const newMembers = diffNewMembers(guildId, fetched);
      if (!newMembers.length) continue;

      const startupTs = client.readyAt ? client.readyAt.getTime() : Date.now();
      const realNew = newMembers.filter(m => {
        return !m.joinedTimestamp || m.joinedTimestamp >= startupTs - 5000;
      });

      // mark all fetched members as known to avoid repeat alerts next ticks
      for (const m of newMembers) knownMembers[guildId].add(m.id);
      await savePersistence();

      if (!realNew.length) continue;

      for (const m of realNew) {
        await scheduleNotify(m, guild);
      }

    } catch (err) {
      console.warn(`Poll error for guild ${guild?.name || guildId}:`, err?.message || err);
    }
  }
}

// small keepalive server
http.createServer((req, res) => {
  res.writeHead(200);
  res.end("Selfbot polling service running");
}).listen(process.env.PORT || 3000, () => {
  console.log(`HTTP server listening on ${process.env.PORT || 3000}`);
});

client.on("ready", async () => {
  console.log(`Logged in as ${client.user.username} (${client.user.id})`);

  // 1) Try to load persistence from disk
  const hadPersistence = await loadPersistence();

  // 2) Initialize knownMembers from cache for any guilds missing entries
  for (const [guildId, guild] of client.guilds.cache) {
    if (!knownMembers[guildId]) knownMembers[guildId] = new Set();
    try {
      // prefer cache to avoid heavy fetch on startup
      guild.members.cache.forEach(m => knownMembers[guildId].add(m.id));
      console.log(`Baseline: tracking ${knownMembers[guildId].size} members (cache) in ${guild.name}`);
    } catch (err) {
      console.warn("Error initializing guild cache:", err);
    }
  }

  // 3) If there was no persistence file, save the baseline now.
  //    This prevents the bot from treating everyone as new on the very next tick
  //    *provided the filesystem is persistent between restarts*.
  if (!hadPersistence) {
    console.log("No prior persistence file — writing baseline to disk so restarts that don't wipe the disk won't re-alert.");
    await savePersistence();
  } else {
    // still save to ensure file is in-sync with cache (quick small write)
    await savePersistence();
  }

  // 4) event guard to catch real joins
  client.on("guildMemberAdd", async (member) => {
    try {
      if (!member || !member.guild) return;
      const gid = member.guild.id;
      if (!knownMembers[gid]) knownMembers[gid] = new Set();
      if (knownMembers[gid].has(member.id)) return;
      if (member.joinedTimestamp && client.readyAt && member.joinedTimestamp < client.readyAt.getTime() - 2000) return;

      knownMembers[gid].add(member.id);
      await savePersistence();

      // INSTANT notification for real event (no debounce)
      try {
        const channel = await client.channels.fetch(cfg.logChannelId);
        if (channel) {
          const msg = formatJoinLog(member);
          await channel.send(msg);
        }
      } catch (err) {
        console.warn("Failed to send instant join log:", err);
      }
    } catch (err) {
      console.warn("Error in guildMemberAdd handler:", err);
    }
  });

  // 5) start polling loop
  setInterval(() => {
    pollWorker().catch(err => console.warn("pollWorker crashed:", err));
  }, cfg.pollInterval);

  console.log("Polling started.");
});

// try to persist on graceful shutdowns
async function gracefulSaveAndExit(code = 0) {
  try {
    console.log("Saving known members before exit...");
    await savePersistence();
    // give time for write to complete (since savePersistence is debounced)
    await new Promise((resolve) => setTimeout(resolve, 1000));
  } catch (err) {
    console.warn("Error while saving during shutdown:", err);
  } finally {
    process.exit(code);
  }
}

process.on("SIGINT", () => gracefulSaveAndExit(0));
process.on("SIGTERM", () => gracefulSaveAndExit(0));
process.on("uncaughtException", (err) => {
  console.error("Uncaught exception:", err);
  gracefulSaveAndExit(1);
});

client.on("error", (err) => console.warn("Client error:", err));
client.on("warn", (msg) => console.warn("Client warn:", msg));

client.login(cfg.token).catch(err => console.error("Login failed:", err));
