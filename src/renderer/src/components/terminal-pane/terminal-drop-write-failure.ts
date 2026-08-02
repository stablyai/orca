import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'

export type TerminalDropWriteFailureReason = 'operation-timeout' | 'target-stale' | 'write-rejected'

export function showTerminalDropWriteFailure(
  reason: TerminalDropWriteFailureReason | undefined
): void {
  if (!reason || reason === 'target-stale') {
    return
  }
  toast.error(
    reason === 'operation-timeout'
      ? translate(
          'auto.components.terminal.pane.terminal.drop.handler.writeTimeout',
          'File drop cancelled: terminal did not accept the path before the safety timeout.'
        )
      : translate(
          'auto.components.terminal.pane.terminal.drop.handler.writeRejected',
          'File drop cancelled: terminal could not accept the path.'
        )
  )
}
