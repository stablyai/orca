// Retain same-terminal input for bounded automatic recovery, never for an arbitrarily late reconnect.
export const REMOTE_RUNTIME_DISCONNECTED_INPUT_GRACE_MS = 5 * 60_000

/** One grace clock per outage; retries begun within it carry the whole ordered hold through one recovery window so dropping an earlier Ctrl+C cannot alter later commands. Check lazily to keep latched panes quiescent. */
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
