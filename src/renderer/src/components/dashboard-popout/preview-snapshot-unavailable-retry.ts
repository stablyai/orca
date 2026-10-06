const UNAVAILABLE_RETRY_MIN_MS = 250
const UNAVAILABLE_RETRY_MAX_MS = 5000
const INITIAL_SNAPSHOT_GRACE_MS = 5000

/**
 * A missing snapshot is never a verdict on the pty. Retry with backoff from 250 ms up to
 * 5 s, and only report "unavailable" once a terminal exists or the spawn grace has run out:
 * spawning can precede the first snapshot, a prolonged outage still gets honest feedback.
 */
export function createPreviewSnapshotUnavailableRetry(args: {
  retry: () => void
  showUnavailable: () => void
}): {
  isUnavailable: () => boolean
  noteUnavailable: (hasTerminal: boolean) => void
  noteAvailable: () => void
  dispose: () => void
} {
  const initialSnapshotDeadline = Date.now() + INITIAL_SNAPSHOT_GRACE_MS
  let timer: number | null = null
  let retryMs = UNAVAILABLE_RETRY_MIN_MS
  let unavailable = false
  const clear = (): void => {
    if (timer !== null) {
      window.clearTimeout(timer)
      timer = null
    }
  }
  return {
    isUnavailable: () => unavailable,
    noteUnavailable: (hasTerminal) => {
      unavailable = true
      clear()
      if (hasTerminal || Date.now() >= initialSnapshotDeadline) {
        args.showUnavailable()
      }
      timer = window.setTimeout(() => {
        timer = null
        args.retry()
      }, retryMs)
      retryMs = Math.min(UNAVAILABLE_RETRY_MAX_MS, retryMs * 2)
    },
    noteAvailable: () => {
      unavailable = false
      clear()
      retryMs = UNAVAILABLE_RETRY_MIN_MS
    },
    dispose: clear
  }
}
