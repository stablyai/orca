import type { RoutineRunStatus } from '../../../../../shared/cloud-api/cloud-api-types'

const ACTIVE: ReadonlySet<RoutineRunStatus> = new Set(['queued', 'starting', 'running', 'posting'])

/** A run that has not finished yet (Run now is unavailable and the history polls). */
export function isActiveRunStatus(status: RoutineRunStatus): boolean {
  return ACTIVE.has(status)
}
