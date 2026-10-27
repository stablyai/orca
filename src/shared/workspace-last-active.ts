import { ORCA_SIDEBAR_INPUTS_IS_MAIN } from './sidebar-inputs-switch'
import {
  getWorkspaceCleanupInactivityReasons,
  type WorkspaceCleanupCandidate
} from './workspace-cleanup'

/** With the switch on, visits count because terminal start/exit no longer advance Recent; plain-shell work must not appear idle. */
export function getWorkspaceLastActiveAt(
  lastActivityAt: number,
  lastVisitedAt: number | undefined
): number {
  if (!ORCA_SIDEBAR_INPUTS_IS_MAIN) {
    return lastActivityAt
  }
  const finite = (value: number | undefined): number =>
    value !== undefined && Number.isFinite(value) ? value : 0
  return Math.max(finite(lastActivityAt), finite(lastVisitedAt))
}

/** A cleanup candidate seen with the client's visit; a newer visit can only drop idle reasons. */
export function withCleanupVisitEvidence(
  candidate: WorkspaceCleanupCandidate,
  lastVisitedAt: number | undefined,
  now: number
): WorkspaceCleanupCandidate {
  const lastActiveAt = getWorkspaceLastActiveAt(candidate.lastActivityAt, lastVisitedAt)
  if (lastActiveAt <= candidate.lastActivityAt) {
    return candidate
  }
  const reasons = getWorkspaceCleanupInactivityReasons(
    { isArchived: candidate.reasons.includes('archived'), lastActivityAt: lastActiveAt },
    now
  ).filter((reason) => candidate.reasons.includes(reason))
  return { ...candidate, lastActivityAt: lastActiveAt, reasons }
}
