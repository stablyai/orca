export const REMOTE_RUNTIME_RECOVERY_DELAYS_MS = [
  250, 500, 1000, 2000, 4000, 8000, 15_000, 30_000
] as const

// Include the router’s full RPC timeout because silently dropped links spend it on every retry.
export const REMOTE_RUNTIME_RECOVERY_ATTEMPT_BUDGET_MS = 15_000

// Derive deadline from every backoff plus attempt timeout; independent literals made later retries unreachable, and contact loss proves no exit (#11305).
export const REMOTE_RUNTIME_AUTO_RECOVERY_TIMEOUT_MS =
  REMOTE_RUNTIME_RECOVERY_DELAYS_MS.reduce((total, delayMs) => total + delayMs, 0) +
  REMOTE_RUNTIME_RECOVERY_DELAYS_MS.length * REMOTE_RUNTIME_RECOVERY_ATTEMPT_BUDGET_MS
