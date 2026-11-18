import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type { BackgroundWorkerApi } from '../../../../../preload/api/diagnostics/background-worker-api'

const TOAST_ID = 'background-worker-paused'

function showPausedToast(api: BackgroundWorkerApi): void {
  toast.error(
    translate(
      'backgroundWorkerPaused.title',
      'Some background work paused after crashing repeatedly'
    ),
    {
      id: TOAST_ID,
      description: translate(
        'backgroundWorkerPaused.description',
        'Claude chat recovery is off until you retry. Copy, rewind and Space scans resume when you start them again.'
      ),
      // Kept until acted on or resumed: it is the way back.
      duration: Number.POSITIVE_INFINITY,
      action: {
        label: translate('backgroundWorkerPaused.retry', 'Retry'),
        onClick: (event) => {
          // Keep it until the retry lands, so a failed request leaves Retry in place.
          event.preventDefault()
          void api
            .retry()
            .then(() => toast.dismiss(TOAST_ID))
            .catch(() => undefined)
        }
      }
    }
  )
}

/** Repeated crashes paused heavy background work; say what stopped and offer the way back. */
export function registerBackgroundWorkerPausedIpcBridge(unsubs: (() => void)[]): void {
  const api = window.api.backgroundWorker
  if (!api) {
    return
  }
  unsubs.push(api.onPaused(() => showPausedToast(api)))
  unsubs.push(api.onResumed(() => toast.dismiss(TOAST_ID)))
  void api
    .isPaused()
    .then((paused) => {
      if (paused) {
        showPausedToast(api)
      }
    })
    .catch(() => undefined)
}
