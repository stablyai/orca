import type { MutableRefObject } from 'react'

export function clearMarkdownPreviewReviewTimers(
  latestTimeoutRef: MutableRefObject<number | null>,
  pendingTimeouts: readonly number[]
): void {
  const latestTimeout = latestTimeoutRef.current
  if (latestTimeout !== null) {
    window.clearTimeout(latestTimeout)
    latestTimeoutRef.current = null
  }
  for (const timeout of pendingTimeouts) {
    if (timeout !== latestTimeout) {
      window.clearTimeout(timeout)
    }
  }
}
