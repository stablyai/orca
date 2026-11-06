import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { consumeShutdownCheckpointFailureReason } from '../../../shared/renderer-shutdown-events'

export function showShutdownCheckpointFailureToast(
  canceledAction: 'quit' | 'reload' = 'quit'
): void {
  const reason = consumeShutdownCheckpointFailureReason()
  if (!reason) {
    return
  }
  toast.error(
    canceledAction === 'reload'
      ? translate(
          'auto.components.Terminal.reloadSnapshotSaveFailed',
          'Reload canceled: the session snapshot could not be saved ({{value0}}).',
          { value0: reason }
        )
      : translate(
          'auto.components.Terminal.quitSnapshotSaveFailed',
          'Quit canceled: the session snapshot could not be saved ({{value0}}).',
          { value0: reason }
        )
  )
}
