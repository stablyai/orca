// Which Slack workspace a bot's setup goes to, from the workspaces its host's other bots are in.
import { readBots } from '@/lib/bot-catalog'
import { botSlackApps, type Bot } from '../../../../../shared/bot-types'

/** The bots on the bot's own host: Slack grants belong to that host's Orca account. */
export function hostBots(bot: Bot): Bot[] {
  return readBots().filter((entry) => entry.hostId === bot.hostId)
}

/** The workspace a later bot reuses: the one another bot's app is in, most recent first. */
export function knownSlackTeam(bots: readonly Bot[], botId: string): string | null {
  const others = bots.filter((bot) => bot.id !== botId && bot.slack)
  others.sort((a, b) => b.updatedAt - a.updatedAt)
  return others[0]?.slack?.teamId ?? null
}

/** Workspaces other bots on this computer are in that this bot is not, most recent first. */
export function otherSlackTeams(bots: readonly Bot[], bot: Bot): string[] {
  const own = new Set(botSlackApps(bot).map((app) => app.teamId))
  const others = bots
    .filter((entry) => entry.id !== bot.id)
    .sort((a, b) => b.updatedAt - a.updatedAt)
  return [
    ...new Set(others.flatMap((entry) => botSlackApps(entry).map((app) => app.teamId)))
  ].filter((teamId) => !own.has(teamId))
}
