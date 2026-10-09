// Why bounded: a pane whose auto-recovery window ran out still reattaches the same terminal on its
// own (P1-3), so its held input waits for that, but never for an arbitrary later reconnect.
export const REMOTE_RUNTIME_DISCONNECTED_INPUT_GRACE_MS = 5 * 60_000

/**
 * Starts once per outage when the pane gives up; only a recovered or disposed pane resets it.
 * Why no timer: a latched pane must stay quiescent, so expiry is checked when input moves.
 */
export function createRemoteRuntimeDisconnectedInputGrace(now: () => number = Date.now): {
  start: () => void
  reset: () => void
  isExpired: () => boolean
} {
  let startedAt: number | null = null
  return {
    start() {
      startedAt ??= now()
    },
    reset() {
      startedAt = null
    },
    isExpired: () =>
      startedAt !== null && now() - startedAt >= REMOTE_RUNTIME_DISCONNECTED_INPUT_GRACE_MS
  }
}
