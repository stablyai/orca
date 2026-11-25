// The Slack workspaces a bot's setup can reuse: those its host's other bots are in, for the desktop and the phone.
import { botSlackApps, type Bot } from '../bot-types'

type SlackTeamsBot = Pick<Bot, 'id' | 'slack' | 'slackApps'> & { updatedAt?: number }

/** Workspaces other bots on this computer are in that this bot is not, most recent first. */
export function otherSlackTeams(bots: readonly SlackTeamsBot[], bot: SlackTeamsBot): string[] {
  const own = new Set(botSlackApps(bot).map((app) => app.teamId))
  const others = bots
    .filter((entry) => entry.id !== bot.id)
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
  return [
    ...new Set(others.flatMap((entry) => botSlackApps(entry).map((app) => app.teamId)))
  ].filter((teamId) => !own.has(teamId))
}
