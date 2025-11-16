import "dotenv/config";
import { Client } from "discord.js-selfbot-v13";
import http from "http";

const cfg = {
  token: process.env.TOKEN,
  logChannelId: process.env.CHANNEL_ID,
  pollInterval: 60_000 // 1 minute polling for stability
};

const client = new Client();
const knownMembers = {}; // { guildId: Set(memberIds) }

// Display tags safely
function displayTag(user) {
  if (user.tag) return user.tag;
  if (user.discriminator && user.discriminator !== "0") {
    return `${user.username}#${user.discriminator}`;
  }
  return user.username;
}

// Tiny HTTP server for Render
http.createServer((req, res) => {
  res.writeHead(200);
  res.end("Bot is running!");
}).listen(process.env.PORT || 3000, () => {
  console.log(`HTTP server listening on port ${process.env.PORT || 3000}`);
});

client.on("ready", async () => {
  console.log(`Logged in as ${client.user.username}`);

  // Initialize known members for all guilds
  for (const [guildId, guild] of client.guilds.cache) {
    try {
      const members = await guild.members.fetch();
      knownMembers[guildId] = new Set(members.map((m) => m.id));
      console.log(`Tracking ${members.size} members in ${guild.name}`);
    } catch (err) {
      console.warn(`Failed to fetch full members for ${guild.name}, using cache.`);
      knownMembers[guildId] = new Set(guild.members.cache.map((m) => m.id));
      console.log(`Tracking ${knownMembers[guildId].size} members (cached) in ${guild.name}`);
    }
  }

  // Polling loop
  setInterval(async () => {
    for (const [guildId, guild] of client.guilds.cache) {
      try {
        let members;
        try {
          members = await guild.members.fetch(); // attempt full fetch
        } catch {
          members = guild.members.cache; // fallback to cache for large servers
        }

        for (const [memberId, member] of members) {
          if (!knownMembers[guildId].has(memberId)) {
            knownMembers[guildId].add(memberId); // mark as seen

            const channel = await client.channels.fetch(cfg.logChannelId);
            if (!channel) continue;

            const user = member.user;
            const createdDate = `<t:${Math.floor(user.createdTimestamp / 1000)}:F> (<t:${Math.floor(user.createdTimestamp / 1000)}:R>)`;
            const joinedDate = member.joinedTimestamp ? `<t:${Math.floor(member.joinedTimestamp / 1000)}:F>` : "Unknown";
            const nickname = member.nickname || "None";
            const pending = member.pending ? "Yes" : "No";
            const boostingSince = member.premiumSince
              ? `<t:${Math.floor(member.premiumSinceTimestamp / 1000)}:F>`
              : "Not Boosting";
            const timedOutUntil = member.communicationDisabledUntilTimestamp
              ? `<t:${Math.floor(member.communicationDisabledUntilTimestamp / 1000)}:F>`
              : "No Timeout";
            const roles = member.roles.cache.filter((r) => r.id !== guild.id);
            const rolesCount = roles.size;
            const highestRole = rolesCount ? roles.sort((a, b) => b.position - a.position).first() : null;
            const roleNames = rolesCount ? roles.map((r) => r.name) : [];
            const avatarUrl = user.displayAvatarURL({ size: 1024 }) || null;
            const bannerUrl = user.banner ? user.bannerURL({ size: 1024 }) : null;
            const flagsArr = user.flags?.toArray() || [];

            const lines = [
              `📥 **Member Joined**`,
              `\`\`\`ini`,
              `[User]`,
              `Username = ${displayTag(user)}`,
              `Mention = <@${user.id}>`,
              `ID = ${user.id}`,
              `Bot = ${user.bot ? "Yes" : "No"}`,
              `System = ${user.system ? "Yes" : "No"}`,
              ``,
              `[Account Info]`,
              `Created = ${createdDate}`,
              `Joined Server = ${joinedDate}`,
              ``,
              `[Server Details]`,
              `Guild = ${guild.name} (${guild.id})`,
              `Nickname = ${nickname}`,
              `Pending Screening = ${pending}`,
              `Boosting Since = ${boostingSince}`,
              `Timeout Until = ${timedOutUntil}`,
              ``,
              `[Roles]`,
              `Total Count = ${rolesCount}`,
              rolesCount ? `Top Role = ${highestRole.name} (${highestRole.id})` : null,
              roleNames.length ? `Role List = ${roleNames.join(", ")}` : null,
              ``,
              `[Media]`,
              avatarUrl ? `Avatar = Available` : `Avatar = None`,
              bannerUrl ? `Banner = Available` : `Banner = None`,
              `Badges/Flags = ${flagsArr.length ? flagsArr.join(", ") : "None"}`,
              `\`\`\``,
              ``,
              `**Username:** \`\`\`${displayTag(user)}\`\`\``,
              avatarUrl ? `**Avatar:** ${avatarUrl}` : null,
              bannerUrl ? `**Banner:** ${bannerUrl}` : null
            ].filter(Boolean);

            await channel.send(lines.join("\n"));
          }
        }
      } catch (err) {
        console.warn(`Skipped guild ${guild.name} due to error: ${err?.message || err}`);
      }
    }
  }, cfg.pollInterval);
});

client.login(cfg.token);
