export const PTY_SESSION_COMMAND_TIMEOUT_MS = 2_500
export const PTY_SESSION_VERIFY_TIMEOUT_MS = 500

// Why: POSIX teardown performs two ownership proofs, one bounded tree
// discovery, and one final exit verification before it can acknowledge.
export const POSIX_PTY_SESSION_TEARDOWN_TIMEOUT_MS =
  PTY_SESSION_COMMAND_TIMEOUT_MS * 3 + PTY_SESSION_VERIFY_TIMEOUT_MS

// Why: node-pty can spend over 5s enumerating a Windows console tree before
// its fallback runs; leave bounded headroom for the native exit event to land.
export const WINDOWS_PTY_EXIT_TIMEOUT_MS = 8_000

export const RELAY_PTY_IMMEDIATE_SHUTDOWN_TIMEOUT_MS = Math.max(
  POSIX_PTY_SESSION_TEARDOWN_TIMEOUT_MS,
  WINDOWS_PTY_EXIT_TIMEOUT_MS
)

// Why: the caller must outlive the relay's full teardown budget plus one
// bounded second for SSH request/response delivery on a high-latency link.
export const SSH_PTY_IMMEDIATE_SHUTDOWN_TIMEOUT_MS = RELAY_PTY_IMMEDIATE_SHUTDOWN_TIMEOUT_MS + 1_000
