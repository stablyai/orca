import { translate } from '@/i18n/i18n'
import type { Bot } from '../../../../../shared/bot-types'
import { HOW_TO_ASK_ESCAPED } from '../BotHowToAsk'
import { hostSetupErrorMessage } from '../bot-host-copy'

/** What to tell the owner for a bot-Slack error code, the cloud's or the host's; `hostName` names a server. */
export function botSlackErrorMessage(code: string, hostName: string | null): string {
  const onHost = hostSetupErrorMessage(code, 'Slack', hostName)
  if (onHost) {
    return onHost
  }
  switch (code) {
    case 'invalid_request':
      return translate(
        'bots.slack.errors.notAToken',
        'That is not a configuration refresh token. It starts with xoxe-.'
      )
    case 'grant_expired':
      return translate(
        'bots.slack.errors.grantExpired',
        'Slack no longer accepts this workspace’s token. Generate a new one and paste it.'
      )
    case 'rate_limited':
      return translate(
        'bots.slack.errors.rateLimited',
        'Too many tries. Wait a minute, then try again.'
      )
    case 'slack_unavailable':
      return translate('bots.slack.errors.slackUnavailable', 'Slack did not answer. Try again.')
    case 'slack_refused':
      return translate('bots.slack.errors.slackRefused', 'Slack refused to set up the app.')
    case 'unknown_bot':
      return translate(
        'bots.slack.errors.unknownBot',
        'Orca Cloud has not seen this bot yet. Try again in a minute.'
      )
    case 'wrong_workspace':
      return translate(
        'bots.slack.errors.wrongWorkspace',
        'This bot’s Slack app is in another workspace. Remove it from Slack first.'
      )
    case 'handoff_expired':
      return translate(
        'bots.slack.errors.handOffExpired',
        'That hand-off expired or was already used. Try again.'
      )
    case 'not_installed':
      return translate('bots.slack.errors.notInstalled', 'Add this bot to Slack first.')
    case 'signed_out':
      return translate('bots.slack.errors.signedOut', 'Sign in to Orca to connect Slack.')
    case 'cloud_unreachable':
      return translate(
        'bots.slack.errors.unreachable',
        'Orca Cloud could not be reached. Check your connection and try again.'
      )
    default:
      return translate('bots.errors.generic', 'Something went wrong. Try again.')
  }
}

/** "How to ask" in Slack; render it with BotHowToAsk. */
export function slackHowToAsk(bot: Pick<Bot, 'name'>): string {
  return translate(
    'bots.slack.howToAsk',
    'Mention <code>@{{name}}</code> in a channel, or send it a direct message.',
    { name: bot.name, ...HOW_TO_ASK_ESCAPED }
  )
}
