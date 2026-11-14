import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'

// Target derivation keeps English reasons as comparison sentinels; translate only for display.
export function agentSendDisabledReasonLabel(reason: string, t: Translate = translate): string {
  switch (reason) {
    case 'Agent needs permission':
      return t('agentSendTargets.disabledReason.needsPermission', 'Agent needs permission')
    case 'Terminal is no longer available':
      return t(
        'auto.components.editor.ReviewNotesSendMenu.terminalGone',
        'Terminal is no longer available'
      )
    default:
      return reason
  }
}
