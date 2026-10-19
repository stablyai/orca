import { ORCA_SIDEBAR_INPUTS_IS_MAIN } from './sidebar-inputs-switch'
import {
  getWorkspaceCleanupInactivityReasons,
  type WorkspaceCleanupCandidate
} from './workspace-cleanup'

/**
 * When the user last used a workspace, for "last active" readers (cleanup, the jump palette).
 * Switch on, terminal start and exit no longer write the Recent stamp, so a later visit counts:
 * a workspace you work in with plain shells is never idle.
 */
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
