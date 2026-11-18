import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'

/** Repeated crashes paused heavy background work; say what stopped and offer the way back. */
export function registerBackgroundWorkerPausedIpcBridge(unsubs: (() => void)[]): void {
  const api = window.api.backgroundWorker
  if (!api) {
    return
  }
  unsubs.push(
    api.onPaused(() => {
      toast.error(
        translate(
          'backgroundWorkerPaused.title',
          'Orca paused some background work after it crashed 3 times'
        ),
        {
          id: 'background-worker-paused',
          description: translate(
            'backgroundWorkerPaused.description',
            'Copying, rewinding and recovering Claude chats and disk usage scans are off until you retry.'
          ),
          // Kept until acted on: it is the way back.
          duration: Number.POSITIVE_INFINITY,
          action: {
            label: translate('backgroundWorkerPaused.retry', 'Retry'),
            onClick: () => void api.retry()
          }
        }
      )
    })
  )
}
