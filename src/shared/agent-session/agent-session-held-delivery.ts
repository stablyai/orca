import { formatUsageLimitResetClock } from './failures/agent-session-usage-limit'

export type WorkerFailureKind = 'network' | 'sign-in' | 'usage-limit' | 'provider' | 'unknown'

export type AgentSessionHeldDelivery = {
  delivered: false
  state: 'held'
  reason: { kind: 'worker_failed'; failure: WorkerFailureKind }
  failureId: string
  target: { sessionId: string; dispatchId?: string }
  waiting: number
  individuallyHeld?: number
  resetsAt?: number
  recoveryUsed?: boolean
  workerName?: string
  provider?: string
  runtimeFence?: number
}

export type AgentSessionFailureResumeResult = {
  status:
    | 'resumed'
    | 'not-failed'
    | 'stale-failure'
    | 'already-used'
    | 'blocked'
    | 'not-retryable'
    | 'message-attached'
  waiting: number
  stillHeld?: number
}

export function heldWorkerDeliveryText(
  held: AgentSessionHeldDelivery,
  names: {
    worker: string
    owner: string
    coordinator?: string
    provider: string
    canResume: boolean
  }
): { message: string; hint: string | null } {
  const { worker, owner, coordinator, provider } = names
  const failure = held.reason.failure
  if (held.recoveryUsed && (failure === 'network' || failure === 'provider')) {
    return {
      message: `Held, not delivered: ${worker} failed again after a ${failure === 'network' ? 'network' : provider} error. Ask ${owner} to resume it.`,
      hint: null
    }
  }
  const cause = {
    network: 'stopped after a network error',
    provider: `stopped after a ${provider} error`,
    'sign-in': 'is signed out',
    'usage-limit': 'hit its usage limit',
    unknown: 'stopped after an unknown error'
  }[failure]
  const message = `Held, not delivered: ${worker} ${cause}. Delivers when it's resumed.`
  const transient = failure === 'network' || failure === 'provider'
  const hint = transient
    ? names.canResume && held.target.dispatchId
      ? `Resume once: orca orchestration send --to dispatch:${held.target.dispatchId} --resume --failure-id ${held.failureId}`
      : `Ask ${coordinator ?? owner} to resume it.`
    : failure === 'sign-in'
      ? `Ask ${owner} to sign in.`
      : failure === 'usage-limit'
        ? held.resetsAt
          ? `Ask ${owner} to resume it after ${formatUsageLimitResetClock(held.resetsAt)}.`
          : `Ask ${owner} to resume it.`
        : `Ask ${owner} to check ${worker}.`
  return { message, hint }
}

export const WORKER_HELD_DELIVERY_ERROR_CODES = [
  'recipient_delivery_held',
  'recipient_delivery_unconfirmed',
  'worker_resume_unavailable',
  'worker_resume_unsupported',
  'worker_resume_stale-failure',
  'worker_resume_already-used',
  'worker_resume_blocked',
  'worker_resume_not-retryable',
  'worker_resume_message-attached'
] as const
