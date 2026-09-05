/** Shared timing contracts for agent submission and worker-start transports. */
import { MAX_TIMER_DELAY_MS } from './timer-delay'

export const AGENT_PROMPT_EFFECT_TIMEOUT_MS = 30_000
/** Extra verification time granted once when the injected payload is still visible in the
 *  composer after the effect window: a parked prompt is being re-submitted, not lost. */
export const AGENT_PROMPT_PENDING_COMPOSER_GRACE_MS = 30_000
/** Ceiling on one prompt submission's verification, grace included. */
export const AGENT_PROMPT_VERIFICATION_MAX_MS =
  AGENT_PROMPT_EFFECT_TIMEOUT_MS + AGENT_PROMPT_PENDING_COMPOSER_GRACE_MS
/** Bound on waiting for a booting TUI's composer before the paste is written. */
export const AGENT_PROMPT_COMPOSER_READY_TIMEOUT_MS = 20_000
/** Everything one sendTerminalAgentPrompt can spend before it answers. */
export const AGENT_PROMPT_SUBMISSION_MAX_MS =
  AGENT_PROMPT_COMPOSER_READY_TIMEOUT_MS + AGENT_PROMPT_VERIFICATION_MAX_MS
export const ORCHESTRATION_CONTRACT_PREFLIGHT_TIMEOUT_MS = 5_000
export const ORCHESTRATION_READINESS_TIMEOUT_MS = 60_000
export const ORCHESTRATION_FEDERATION_ATTACH_GRACE_MS = AGENT_PROMPT_SUBMISSION_MAX_MS + 10_000
export const ORCHESTRATION_WORKER_START_CLIENT_GRACE_MS = AGENT_PROMPT_SUBMISSION_MAX_MS + 20_000
export const SWALLOWED_ENTER_FIXTURE_TIMEOUT_MS = AGENT_PROMPT_SUBMISSION_MAX_MS + 30_000

export function resolveWorkerStartReadinessTimeoutMs(timeoutMs: number | undefined): number {
  return typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0
    ? timeoutMs
    : ORCHESTRATION_READINESS_TIMEOUT_MS
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
