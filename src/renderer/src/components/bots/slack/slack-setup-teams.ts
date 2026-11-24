// Which Slack workspace a bot's setup goes to, from the workspaces its host's other bots are in.
import { readBots } from '@/lib/bot-catalog'
import { readBotSlack, slackTeamState } from '@/lib/bot-slack-state'
import type { Bot } from '../../../../../shared/bot-types'
import { otherSlackTeams } from '../../../../../shared/bots/bot-slack-setup-teams'

/** The bots on the bot's own host: Slack grants belong to that host's Orca account. */
export function hostBots(bot: Bot): Bot[] {
  return readBots().filter((entry) => entry.hostId === bot.hostId)
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
