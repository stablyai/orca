// A bot's Discord people follow its Discord servers: a server it left takes its people with it.
import { botDiscordGuilds, botMemberSource, type Bot, type BotMember } from '../bot-types'

/** The bot's people, less any Discord person of a server it is no longer in. */
export function membersInDiscordGuilds(bot: Pick<Bot, 'discord' | 'members'>): BotMember[] {
  const guilds = new Set(botDiscordGuilds(bot).map((guild) => guild.guildId))
  return bot.members.filter(
    (member) =>
      botMemberSource(member) !== 'discord' ||
      (member.workspaceId !== undefined && guilds.has(member.workspaceId))
  )
}
