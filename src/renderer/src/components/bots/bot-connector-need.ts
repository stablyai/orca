import type { Translate } from '@/i18n/use-translate'
import type { BotConnectorEntry } from './bot-connector-entries'
import { botToolSignInWords } from './bot-tool-sign-in-action'
import { botToolSignInFace } from '../../../../shared/bots/bot-tool-sign-in-face'

/** What a connector needs, in words: an app's sign-in or Slack's update, else sign in again or fix it. */
export function connectorNeed(entry: BotConnectorEntry, name: string, t: Translate): string {
  if (entry.kind === 'slack' && entry.updateNeeded) {
    return t('settings.bots.slackStatus.updateNeeded', 'Update needed')
  }
  const signIn =
    entry.kind === 'app'
      ? botToolSignInWords(botToolSignInFace(entry.tool, entry.problem, false, undefined), t, name)
          .need
      : null
  return (
    signIn ?? t('bots.needs.connector', '{{name}} needs you to sign in again or fix it.', { name })
  )
}
