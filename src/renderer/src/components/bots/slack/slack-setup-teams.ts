// Which Slack workspace a bot's setup goes to, from where its Orca account's other bots are.
import { readBots } from '@/lib/bot-catalog'
import { readBotHostOnOwnAccount } from '@/lib/bot-host-orca-account'
import { botSlackApps, type Bot } from '../../../../../shared/bot-types'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../../shared/execution-host/execution-host'

/** The bots on the bot's own host: Slack grants belong to that host's Orca account. */
export function hostBots(bot: Pick<Bot, 'hostId'>): Bot[] {
  return readBots().filter((entry) => entry.hostId === bot.hostId)
}

/** The workspace a later bot reuses: the one another bot's app is in, most recent first. */
export function knownSlackTeam(bots: readonly Bot[], botId: string): string | null {
  const others = bots.filter((bot) => bot.id !== botId && bot.slack)
  others.sort((a, b) => b.updatedAt - a.updatedAt)
  return others[0]?.slack?.teamId ?? null
}

/**
 * `knownSlackTeam` from the bot's host's bots, else from this desktop's own when that host is
 * signed in to this desktop's Orca account, which then holds the same grants.
 */
export async function knownAccountSlackTeam(bot: Bot): Promise<string | null> {
  const known = knownSlackTeam(hostBots(bot), bot.id)
  if (known || bot.hostId === LOCAL_EXECUTION_HOST_ID) {
    return known
  }
  return (await readBotHostOnOwnAccount(bot.hostId))
    ? knownSlackTeam(hostBots({ hostId: LOCAL_EXECUTION_HOST_ID }), bot.id)
    : null
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
