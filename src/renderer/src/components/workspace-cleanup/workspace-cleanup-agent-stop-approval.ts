import {
  applyWorkspaceCleanupPolicy,
  type WorkspaceCleanupCandidate
} from '../../../../shared/workspace-cleanup'

/**
 * Records on the approved candidate whether the user confirmed stopping an agent there; the
 * delete-time preflight refuses a row whose agent was not approved. Scan snapshots can carry
 * `live-agent` without the user ever seeing the stop step, so the blocker is rewritten, not kept.
 */
export function withWorkspaceCleanupAgentStopApproval(
  candidate: WorkspaceCleanupCandidate,
  approved: boolean
): WorkspaceCleanupCandidate {
  const hasApproval = candidate.blockers.includes('live-agent')
  if (hasApproval === approved) {
    return candidate
  }
  return applyWorkspaceCleanupPolicy({
    ...candidate,
    blockers: approved
      ? [...candidate.blockers, 'live-agent']
      : candidate.blockers.filter((blocker) => blocker !== 'live-agent')
  })
}
