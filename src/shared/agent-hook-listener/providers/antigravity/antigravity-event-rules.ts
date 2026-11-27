// Antigravity lifecycle predicates shared by normalization and result discovery.
import { readFirstString } from '../../interactive-tool'

export function isAntigravityStopStillBusy(hookPayload: Record<string, unknown>): boolean {
  return hookPayload.fullyIdle === false || hookPayload.fully_idle === false
}

/** agy ends a turn on a provider error (quota, auth) with terminationReason ERROR; callers check idle. */
export function isAntigravityStopFailed(hookPayload: Record<string, unknown>): boolean {
  return (
    readFirstString(hookPayload, ['terminationReason', 'termination_reason'])?.toLowerCase() ===
    'error'
  )
}
