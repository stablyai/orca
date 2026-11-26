const RECONNECT_FIRST_DELAY_MS = 750
const RECONNECT_MAX_DELAY_MS = 30_000
/** A stream must stay up this long before its next failure counts as fresh rather than a repeat. */
export const RECONNECT_STABLE_STREAM_MS = 10_000

/** Each reconnect waits twice the last, up to the cap, until a read delivers. */
export function createReconnectScheduler(args: {
  shouldStop: () => boolean
  reconnect: () => void
}) {
  let timer: ReturnType<typeof setTimeout> | null = null
  let nextDelay = RECONNECT_FIRST_DELAY_MS
  let deliveringSince: number | null = null
  return {
    schedule(): void {
      if (args.shouldStop() || timer) {
        return
      }
      if (deliveringSince !== null && Date.now() - deliveringSince >= RECONNECT_STABLE_STREAM_MS) {
        nextDelay = RECONNECT_FIRST_DELAY_MS
      }
      deliveringSince = null
      const delay = nextDelay
      nextDelay = Math.min(delay * 2, RECONNECT_MAX_DELAY_MS)
      timer = setTimeout(() => {
        timer = null
        if (!args.shouldStop()) {
          args.reconnect()
        }
      }, delay)
    },
    /** A stream delivered. Only one that then stays up resets the wait, so a stream the host ends
     *  right after its first frames cannot retry every 750 ms forever. */
    noteDelivered(): void {
      deliveringSince ??= Date.now()
    },
    /** A one-shot read delivered, so the next failure is retried soon again. */
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
