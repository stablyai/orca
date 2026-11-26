import type { WorkspaceCleanupCandidate } from '../../../../../../shared/workspace-cleanup/workspace-cleanup'

/** Stamp explicit agent-stop consent; scan live-agent labels alone are not approval and must be rewritten before final dispatch. */
export function withWorkspaceCleanupAgentStopApproval(
  candidate: WorkspaceCleanupCandidate,
  approved: boolean
): WorkspaceCleanupCandidate {
  const hasApproval = candidate.blockers.includes('live-agent')
  if (hasApproval === approved) {
    return candidate
  }
  return {
    ...candidate,
    blockers: approved
      ? [...candidate.blockers, 'live-agent']
      : candidate.blockers.filter((blocker) => blocker !== 'live-agent')
  }
}
