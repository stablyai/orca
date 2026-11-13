import { installWindowVisibilityInterval } from '@/lib/window-activity/window-visibility-interval'
import type { CommunitySyncStatus } from '../../../../shared/community-catalog'
export function watchCommunitySync(
  read: () => Promise<CommunitySyncStatus>,
  onStatus: (status: CommunitySyncStatus) => void
): () => void {
  let cancelled = false
  let pending = false
  let failures = 0
  let retryAt = 0
  const stop = installWindowVisibilityInterval({
    intervalMs: 1000,
    slowWhileUnfocused: true,
    run: () => {
      if (pending || Date.now() < retryAt) {
        return
      }
      pending = true
      void read()
        .then((status) => {
          failures = 0
          retryAt = 0
          if (!cancelled) {
            onStatus(status)
          }
        })
        .catch(() => {
          failures += 1
          retryAt = Date.now() + Math.min(30_000, 1000 * 2 ** failures)
        })
        .finally(() => {
          pending = false
        })
    }
  })
  return () => {
    cancelled = true
    stop()
  }
}
