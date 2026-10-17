import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'

export type TerminalDropWriteFailureReason =
  | 'control-character-path'
  | 'operation-timeout'
  | 'target-stale'
  | 'write-rejected'

export function showTerminalDropWriteFailure(
  reason: TerminalDropWriteFailureReason | undefined
): void {
  if (!reason || reason === 'target-stale') {
    return
  }
  toast.error(getTerminalDropWriteFailureMessage(reason))
}

function getTerminalDropWriteFailureMessage(
  reason: Exclude<TerminalDropWriteFailureReason, 'target-stale'>
): string {
  switch (reason) {
    case 'control-character-path':
      return translate(
        'auto.components.terminal.pane.terminal.drop.handler.controlCharacterPath',
        'File drop cancelled: a path contains control characters.'
      )
    case 'operation-timeout':
      return translate(
        'auto.components.terminal.pane.terminal.drop.handler.writeTimeout',
        'File drop cancelled: terminal did not accept the path before the safety timeout.'
      )
    case 'write-rejected':
      return translate(
        'auto.components.terminal.pane.terminal.drop.handler.writeRejected',
        'File drop cancelled: terminal could not accept the path.'
      )
  }
}
