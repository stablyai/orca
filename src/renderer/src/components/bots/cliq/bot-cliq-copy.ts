import { translate } from '@/i18n/i18n'
import type { Bot } from '../../../../../shared/bot-types'
import { BOT_CLIQ_OFF } from '../../../../../shared/connector-bot-cliq-contract'
import { HOW_TO_ASK_ESCAPED } from '../BotHowToAsk'
import { hostSetupErrorMessage } from '../bot-host-copy'
import { CLIQ_OTHER_ORG } from './cliq-setup-step'

/** What to tell the owner for a Cliq error code, the cloud's or the host's; `hostName` names a server. */
export function botCliqErrorMessage(code: string, hostName: string | null): string {
  const onHost = hostSetupErrorMessage(code, 'Zoho Cliq', hostName)
  if (onHost) {
    return onHost
  }
  switch (code) {
    case BOT_CLIQ_OFF:
      return translate('bots.cliq.errors.off', 'Zoho Cliq is coming soon.')
    case 'expired':
      return translate(
        'bots.cliq.errors.replaced',
        'Zoho didn’t finish. A newer sign-in may have replaced it. Start again.'
      )
    case 'wrong_account':
      return translate(
        'bots.cliq.errors.wrongAccount',
        'This sign-in was started from another Orca account. Connect Zoho Cliq again from this one.'
      )
    case CLIQ_OTHER_ORG:
      return translate(
        'bots.cliq.errors.otherOrg',
        'That sign-in reached another Cliq organization. Sign in to the one this bot is set up in.'
      )
    case 'cliq_grant_expired':
      return translate(
        'bots.cliq.errors.grantExpired',
        'Zoho no longer accepts your sign-in for this organization. Sign in again.'
      )
    case 'cliq_refused':
      return translate(
        'bots.cliq.errors.refused',
        'Zoho Cliq refused to set up the bot. Check that bots are allowed in your organization.'
      )
    case 'cliq_unavailable':
      return translate('bots.cliq.errors.unavailable', 'Zoho Cliq did not answer. Try again.')
    case 'rate_limited':
      return translate(
        'bots.cliq.errors.rateLimited',
        'Too many tries. Wait a few minutes, then try again.'
      )
    case 'signed_out':
      return translate('bots.cliq.errors.signedOut', 'Sign in to Orca to connect Zoho Cliq.')
    case 'cloud_unreachable':
      return translate(
        'bots.cliq.errors.unreachable',
        'Orca Cloud could not be reached. Check your connection and try again.'
      )
    default:
      return translate('bots.errors.generic', 'Something went wrong. Try again.')
  }
}

/** What to type in Cliq to ask the bot: its Cliq bot carries the bot's name. */
export function cliqMention(bot: Pick<Bot, 'name'>): string {
  return `@${bot.name}`
}

/** "How to ask" in Cliq; render it with BotHowToAsk. */
export function cliqHowToAsk(bot: Bot): string {
  return translate(
    'bots.cliq.howToAsk',
    'Mention <code>{{mention}}</code> in a channel or thread, or message it directly.',
    { mention: cliqMention(bot), ...HOW_TO_ASK_ESCAPED }
  )
}
