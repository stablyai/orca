export const ORCHESTRATION_DISPATCH_READY_TIMEOUT_MS = 60_000

export function isInjectedOrchestrationDispatch(method: string, params: unknown): boolean {
  if (method !== 'orchestration.dispatch' || typeof params !== 'object' || params === null) {
    return false
  }
  const dispatch = params as { inject?: unknown; dryRun?: unknown }
  return dispatch.inject === true && dispatch.dryRun !== true
}

export function resolveOrchestrationAgentReadinessTimeoutMs(
  method: string,
  params: unknown
): number | null {
  if (isInjectedOrchestrationDispatch(method, params)) {
    return ORCHESTRATION_DISPATCH_READY_TIMEOUT_MS
  }
  if (method !== 'orchestration.workerStart' && method !== 'orchestration.federationAttachStart') {
    return null
  }
  const requested =
    typeof params === 'object' && params !== null
      ? Number((params as { timeoutMs?: unknown }).timeoutMs)
      : Number.NaN
  return Number.isFinite(requested) && requested > 0
    ? requested
    : ORCHESTRATION_DISPATCH_READY_TIMEOUT_MS
}

export function isOrchestrationAgentReadinessRequest(method: string, params: unknown): boolean {
  return resolveOrchestrationAgentReadinessTimeoutMs(method, params) !== null
}
