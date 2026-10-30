export const HIDDEN_OUTPUT_RESTORE_PENDING_CHARS = 512 * 1024
export const HIDDEN_OUTPUT_RESTORE_DEFERRED_RETRY_MS = 50
export const HIDDEN_OUTPUT_RESTORE_DEFERRED_RETRY_MAX = 3
export const HIDDEN_OUTPUT_RESTORE_FOREGROUND_TIMEOUT_MS = 750
// Restore replay can starve ACKs and generate its own drop markers; suppress repeat fetches, pass live bytes and heal once after flood quiets (rc.7.perf).
export const HIDDEN_OUTPUT_RESTORE_FLOOD_SUPPRESS_MS = 2000
// Bound each task’s refetch loop so live bytes can resume under sustained backpressure.
export const HIDDEN_OUTPUT_RESTORE_MAX_LOOP_ITERATIONS = 3
// Remote nulls during resync/RTT do not prove loss; five quiet repaint cycles outlast the 10s resync/request window before disclosure.
export const HIDDEN_OUTPUT_RESTORE_REMOTE_REARM_MAX = 5
// Why: the host declined seven separate times; each one cost it a real serialize attempt, so stop asking.
export const HIDDEN_OUTPUT_RESTORE_REMOTE_OUTCOME_MAX_ATTEMPTS = 7
// Client-side gates spend no host attempts; allow a larger termination cap spanning several resync windows to avoid false loss banners.
export const HIDDEN_OUTPUT_RESTORE_LOCAL_GATE_MAX_ATTEMPTS = 30
// Disclose skipped hidden output only when recovery is unavailable.
export const HIDDEN_OUTPUT_RESTORE_UNAVAILABLE_WARNING =
  '\r\n[Orca skipped hidden terminal output because main recovery was unavailable.]\r\n'
// Distinguish a permanent host inability to supply an image from exhausted transient retries.
export const PARK_REVEAL_NO_HOST_IMAGE_WARNING =
  "\r\n[Orca could not restore this terminal's history from its host.]\r\n"
