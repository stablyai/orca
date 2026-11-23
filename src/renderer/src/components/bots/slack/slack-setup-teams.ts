// Which Slack workspace a bot's setup goes to, from the workspaces its host's other bots are in.
import { readBots } from '@/lib/bot-catalog'
import { readBotSlack, slackTeamState } from '@/lib/bot-slack-state'
import { botSlackApps, type Bot } from '../../../../../shared/bot-types'

/** The bots on the bot's own host: Slack grants belong to that host's Orca account. */
export function hostBots(bot: Bot): Bot[] {
  return readBots().filter((entry) => entry.hostId === bot.hostId)
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

/** The workspace named for this setup, else every one this computer's other bots are in. */
export function setupTeams(bot: Bot, named: string | undefined): string[] {
  return named ? [named] : otherSlackTeams(hostBots(bot), bot)
}

/** Whether the bot's own app was made in `teamId`, as its last-read Slack state says. */
export function slackAppMadeIn(bot: Bot, teamId: string): boolean {
  const view = readBotSlack(bot)
  return view.status === 'ready' && slackTeamState(view.slack, teamId).state !== 'not_created'
}
