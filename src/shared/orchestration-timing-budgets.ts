/** Shared timing contracts for agent submission and worker-start transports. */
import { MAX_TIMER_DELAY_MS } from './timer-delay'

export const AGENT_PROMPT_EFFECT_TIMEOUT_MS = 30_000
export const ORCHESTRATION_CONTRACT_PREFLIGHT_TIMEOUT_MS = 5_000
export const ORCHESTRATION_READINESS_TIMEOUT_MS = 60_000
export const ORCHESTRATION_FEDERATION_ATTACH_GRACE_MS = AGENT_PROMPT_EFFECT_TIMEOUT_MS + 10_000
export const ORCHESTRATION_WORKER_START_CLIENT_GRACE_MS = AGENT_PROMPT_EFFECT_TIMEOUT_MS + 20_000

export function resolveWorkerStartReadinessTimeoutMs(timeoutMs: number | undefined): number {
  return typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0
    ? timeoutMs
    : ORCHESTRATION_READINESS_TIMEOUT_MS
}

/**
 * How long a structured worker's preamble may wait for its agent: up to the readiness wait, but
 * no longer than the worker start's own timeout leaves plus the allowance a terminal worker's turn
 * observation gets, so the host answers inside the CLI's worker-start grace.
 */
export function resolveStructuredWorkerPreambleBudgetMs(args: {
  startedAtMs: number
  timeoutMs: number
  nowMs: number
}): number {
  const left = args.startedAtMs + args.timeoutMs + AGENT_PROMPT_EFFECT_TIMEOUT_MS - args.nowMs
  return Math.min(ORCHESTRATION_READINESS_TIMEOUT_MS, Math.max(0, left))
}

export function resolveFederationAttachTimeoutMs(
  readinessTimeoutMs = ORCHESTRATION_READINESS_TIMEOUT_MS
): number {
  return readinessTimeoutMs + ORCHESTRATION_FEDERATION_ATTACH_GRACE_MS
}

export function resolveWorkerStartClientTimeoutMs(
  readinessTimeoutMs = ORCHESTRATION_READINESS_TIMEOUT_MS
): number {
  return readinessTimeoutMs + ORCHESTRATION_WORKER_START_CLIENT_GRACE_MS
}

export function isWorkerStartTimeoutWithinTimerLimit(timeoutMs: number | undefined): boolean {
  const readinessTimeoutMs = resolveWorkerStartReadinessTimeoutMs(timeoutMs)
  return (
    Number.isSafeInteger(readinessTimeoutMs) &&
    resolveWorkerStartClientTimeoutMs(readinessTimeoutMs) <= MAX_TIMER_DELAY_MS
  )
}

export function resolveFederationAttachDeadlineMs(args: {
  readinessTimeoutMs?: number
  outerDeadlineMs: number
  nowMs?: number
}): number {
  const nowMs = args.nowMs ?? Date.now()
  return Math.max(
    1,
    Math.min(
      resolveFederationAttachTimeoutMs(args.readinessTimeoutMs),
      args.outerDeadlineMs - nowMs
    )
  )
}
