// One sentence and one action for every "your Orca session is no longer valid" failure, so a
// toast, an inline error and a dialog never disagree about what happened or what to do.
import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'

export function signInAgainMessage(t: Translate = translate): string {
  return t('orcaCloud.signInAgain.message', 'Sign in to Orca again to continue.')
}

export function signInAgainActionLabel(t: Translate = translate): string {
  return t('orcaCloud.signInAgain.action', 'Sign in')
}
