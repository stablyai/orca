export const MAX_REMOTE_TERMINAL_SNAPSHOT_BYTES = 2 * 1024 * 1024

export const REMOTE_TERMINAL_SNAPSHOT_REQUEST_TIMEOUT_MS = 10_000

export const REMOTE_TERMINAL_RESYNC_TIMEOUT_MS = 10_000

// Why: a host that never answers a recovery must reach stall recovery, not retry forever.
export const REMOTE_TERMINAL_RESYNC_MAX_UNANSWERED_TIMEOUTS = 2

// Truncation means host serialization overload; per-chunk retries would stampede it, so back off.
export const REMOTE_TERMINAL_RESYNC_RETRY_BASE_MS = 500

export const REMOTE_TERMINAL_RESYNC_RETRY_MAX_MS = 5_000

// Classify skipped snapshots as benign: live output continues, so no fatal banner.
export const REMOTE_TERMINAL_SNAPSHOT_TOO_LARGE =
  'Remote terminal snapshot exceeded the 2 MiB replay limit; live output will continue.'
