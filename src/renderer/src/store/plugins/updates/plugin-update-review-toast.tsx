// @protected-copy
import { toast } from 'sonner'
import type { PluginUpdateReviewNotice } from '../../../../../shared/plugins/catalog/plugin-update-policy'
import { PluginUpdateReviewToast } from '@/components/plugins/review/PluginUpdateReviewToast'

const TOAST_ID = 'plugin-update-review'
const noticeId = (notice: PluginUpdateReviewNotice): string =>
  `${notice.pluginKey}@${notice.version}`

// What the open toast covers, so a later batch joins it instead of hiding an earlier one.
let showing: PluginUpdateReviewNotice[] = []

function render(): void {
  const notices = showing
  if (notices.length === 0) {
    toast.dismiss(TOAST_ID)
    return
  }
  // Why keyed by the versions: a newer notice must reload its preview, not show the old one under it.
  const key = notices.map(noticeId).join(',')
  toast.custom(() => <PluginUpdateReviewToast key={key} notices={notices} onResolved={resolve} />, {
    id: TOAST_ID,
    duration: Infinity,
    closeButton: false,
    unstyled: true,
    onDismiss: () => {
      showing = []
    }
  })
}

/** Drops only what was handled; a notice that arrived meanwhile stays on screen. */
function resolve(handled: readonly PluginUpdateReviewNotice[]): void {
  const done = new Set(handled.map(noticeId))
  const before = showing
  showing = showing.filter((notice) => !done.has(noticeId(notice)))
  if (showing.length !== before.length) {
    render()
  }
}

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
  render()
}
