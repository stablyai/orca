// @protected-copy
import { toast } from 'sonner'
import type { PluginUpdateReviewNotice } from '../../../../../shared/plugins/catalog/plugin-update-policy'
import { PluginUpdateReviewToast } from '@/components/plugins/review/PluginUpdateReviewToast'

const TOAST_ID = 'plugin-update-review'

// What the open toast covers, so a later batch joins it instead of hiding an earlier one.
let showing: PluginUpdateReviewNotice[] = []

/**
 * Tells the user that automatic updates are waiting on them: one toast, however many. It shows
 * what each adds and can approve them in place; "Details" opens the full review over the app.
 */
export function announcePluginUpdateReviews(fresh: readonly PluginUpdateReviewNotice[]): void {
  if (fresh.length === 0) {
    return
  }
  const freshKeys = new Set(fresh.map((notice) => notice.pluginKey))
  showing = [...showing.filter((notice) => !freshKeys.has(notice.pluginKey)), ...fresh]
  const notices = showing
  const close = (): void => {
    showing = []
  }
  toast.custom(
    (toastId) => <PluginUpdateReviewToast toastId={toastId} notices={notices} onClose={close} />,
    {
      id: TOAST_ID,
      duration: Infinity,
      closeButton: false,
      unstyled: true,
      onDismiss: close
    }
  )
}
