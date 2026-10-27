const RECONNECT_FIRST_DELAY_MS = 750
const RECONNECT_MAX_DELAY_MS = 30_000

/** Each reconnect waits twice the last, up to the cap, until a read delivers. */
export function createReconnectScheduler(args: {
  shouldStop: () => boolean
  reconnect: () => void
}) {
  let timer: ReturnType<typeof setTimeout> | null = null
  let nextDelay = RECONNECT_FIRST_DELAY_MS
  return {
    schedule(): void {
      if (args.shouldStop() || timer) {
        return
      }
      const delay = nextDelay
      nextDelay = Math.min(delay * 2, RECONNECT_MAX_DELAY_MS)
      timer = setTimeout(() => {
        timer = null
        if (!args.shouldStop()) {
          args.reconnect()
        }
      }, delay)
    },
    /** A read delivered, so the next failure is retried soon again. */
    reset(): void {
      nextDelay = RECONNECT_FIRST_DELAY_MS
    },
    /** The host is reachable again: a waiting retry runs now instead of after the grown wait. */
    retryNow(): void {
      nextDelay = RECONNECT_FIRST_DELAY_MS
      if (!timer) {
        return
      }
      clearTimeout(timer)
      timer = null
      if (!args.shouldStop()) {
        args.reconnect()
      }
    },
    dispose(): void {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
    }
  }
}
