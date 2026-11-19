import { translate } from '@/i18n/i18n'
import type { Bot } from '../../../../../shared/bot-types'
import { BOT_LINEAR_OFF } from '../../../../../shared/connector-bot-linear-contract'
import { HOW_TO_ASK_ESCAPED } from '../BotHowToAsk'
import { hostSetupErrorMessage } from '../bot-host-copy'

/** What to tell the owner for a Linear error code, the cloud's or the host's; `hostName` names a server. */
export function botLinearErrorMessage(code: string, hostName: string | null): string {
  const onHost = hostSetupErrorMessage(code, 'Linear', hostName)
  if (onHost) {
    return onHost
  }
  switch (code) {
    case BOT_LINEAR_OFF:
      return translate('bots.linear.errors.off', 'Linear is coming soon.')
    case 'not_linked':
      return translate(
        'bots.linear.errors.notLinked',
        'Connect Linear from a bot’s Connectors to link your account.'
      )
    case 'expired':
      return translate(
        'bots.linear.errors.replaced',
        'Linear didn’t finish. A newer Linear or GitHub connect may have replaced it. Start again.'
      )
    case 'wrong_account':
      return translate(
        'bots.linear.errors.wrongAccount',
        'This sign-in was started from another Orca account. Connect Linear again from this one.'
      )
    case 'already_linked':
      return translate(
        'bots.linear.errors.alreadyLinked',
        'This Orca account is linked to another Linear user in that workspace. Unlink it in Settings › Bots › Linear first.'
      )
    case 'not_a_member':
      return translate(
        'bots.linear.errors.notAMember',
        'Only full members of the Linear workspace can pick people from it.'
      )
    case 'rate_limited':
      return translate(
        'bots.linear.errors.rateLimited',
        'Too many tries. Wait a minute, then try again.'
      )
    case 'linear_unavailable':
      return translate('bots.linear.errors.unavailable', 'Linear did not answer. Try again.')
    case 'signed_out':
      return translate('bots.linear.errors.signedOut', 'Sign in to Orca to connect Linear.')
    case 'cloud_unreachable':
      return translate(
        'bots.linear.errors.unreachable',
        'Orca Cloud could not be reached. Check your connection and try again.'
      )
    default:
      return translate('bots.errors.generic', 'Something went wrong. Try again.')
  }
}

/** "How to ask" on Linear; render it with BotHowToAsk. */
export function linearHowToAsk(bot: Bot): string {
  return translate(
    'bots.linear.howToAsk',
    'Mention <code>@Orca {{handle}}</code> on an issue, or add the label <code>bot:{{handle}}</code>.',
    { handle: bot.folder, ...HOW_TO_ASK_ESCAPED }
  )
}

/** A connector row's description: "Globex · linear.app/globex". */
export function linearWorkspaceDescription(name: string, urlKey: string | undefined): string {
  return urlKey ? `${name} · linear.app/${urlKey}` : name
}

/** A workspace as the owner should recognize it: its name can be copied, its linear.app address can't. */
export function linearWorkspaceLabel(name: string, urlKey: string | undefined): string {
  return urlKey ? `${name} (linear.app/${urlKey})` : name
}

/** Who Orca acts as in Linear, and from where. */
export function linearActsAs(hostName: string | null): string {
  return hostName
    ? translate('bots.linear.setup.actsOnHost', 'Orca acts as that Linear user from {{host}}.', {
        host: hostName
      })
    : translate('bots.linear.setup.actsAsYou', 'Orca acts as you in Linear from this computer.')
}

/** What to type on a Linear issue to ask the bot. */
export function linearMention(bot: Pick<Bot, 'folder'>): string {
  return `@Orca ${bot.folder}`
}

/** The label that asks the bot when added to a Linear issue. */
export function linearLabel(bot: Pick<Bot, 'folder'>): string {
  return `bot:${bot.folder}`
}
