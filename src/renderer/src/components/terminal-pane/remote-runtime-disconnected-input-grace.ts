// Why bounded: a pane whose auto-recovery window ran out still reattaches the same terminal on its
// own (P1-3), so its held input waits for that, but never for an arbitrary later reconnect.
export const REMOTE_RUNTIME_DISCONNECTED_INPUT_GRACE_MS = 5 * 60_000

/**
 * Starts once per outage when the pane gives up; only a recovered or disposed pane resets it.
 * A retry begun inside the grace carries the whole hold until that retry ends: held input is one
 * ordered stream, so dropping its older part (an unsent Ctrl+C) while delivering what was typed
 * after it could run a different command. The next latch checks the original start again, so the
 * overrun is at most one recovery window.
 * Why no timer: a latched pane must stay quiescent, so expiry is checked when input moves.
 */
export function createRemoteRuntimeDisconnectedInputGrace(now: () => number = Date.now): {
  start: () => void
  carryThroughRetry: () => void
  reset: () => void
  isExpired: () => boolean
} {
  let startedAt: number | null = null
  let carried = false
  return {
    start() {
      startedAt ??= now()
      carried = false
    },
    carryThroughRetry() {
      carried = startedAt !== null
    },
    reset() {
      startedAt = null
      carried = false
    },
    isExpired: () =>
      !carried &&
      startedAt !== null &&
      now() - startedAt >= REMOTE_RUNTIME_DISCONNECTED_INPUT_GRACE_MS
  }
}
