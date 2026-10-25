export const REMOTE_RUNTIME_RECOVERY_DELAYS_MS = [
  250, 500, 1000, 2000, 4000, 8000, 15_000, 30_000
] as const

// Why: mirrors DEFAULT_REMOTE_RUNTIME_TIMEOUT_MS in the main-process runtime router; a silently
// dropped link burns the whole RPC timeout on the attempt each backoff step leads into.
export const REMOTE_RUNTIME_RECOVERY_ATTEMPT_BUDGET_MS = 15_000

// Why derived, not hand-tuned: a literal deadline drifted below the ladder it arms, making the last
// backoff steps unreachable dead code (#11305). Loss of contact is never evidence of exit, so the
// window must outlast the schedule it advertises rather than the schedule being trimmed to fit.
export const REMOTE_RUNTIME_AUTO_RECOVERY_TIMEOUT_MS =
  REMOTE_RUNTIME_RECOVERY_DELAYS_MS.reduce((total, delayMs) => total + delayMs, 0) +
  REMOTE_RUNTIME_RECOVERY_DELAYS_MS.length * REMOTE_RUNTIME_RECOVERY_ATTEMPT_BUDGET_MS
