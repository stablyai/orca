export const ORCHESTRATION_ASK_DEFAULT_TIMEOUT_MS = 600_000
export const ORCHESTRATION_ASK_MAX_TIMEOUT_MS = 1_800_000
export const ORCHESTRATION_ASK_CLIENT_GRACE_MS = 5_000

export function clampOrchestrationAskTimeoutMs(timeoutMs: number | undefined): number {
  if (timeoutMs === undefined) {
    return ORCHESTRATION_ASK_DEFAULT_TIMEOUT_MS
  }
  return Math.min(Math.max(0, timeoutMs), ORCHESTRATION_ASK_MAX_TIMEOUT_MS)
}

export function resolveOrchestrationAskClientTimeoutMs(timeoutMs: number | undefined): number {
  return clampOrchestrationAskTimeoutMs(timeoutMs) + ORCHESTRATION_ASK_CLIENT_GRACE_MS
}
