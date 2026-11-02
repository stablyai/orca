import { translate } from '@/i18n/i18n'

// Target derivation keeps English reasons as comparison sentinels; translate only for display.
export function agentSendDisabledReasonLabel(reason: string): string {
  switch (reason) {
    case 'Agent needs permission':
      return translate('agentSendTargets.disabledReason.needsPermission', 'Agent needs permission')
    case 'Agent status is stale':
      return translate('agentSendTargets.disabledReason.statusStale', 'Agent status is stale')
    case 'Terminal is no longer available':
      return translate(
        'auto.components.editor.ReviewNotesSendMenu.terminalGone',
        'Terminal is no longer available'
      )
    default:
      return reason
  }
}
