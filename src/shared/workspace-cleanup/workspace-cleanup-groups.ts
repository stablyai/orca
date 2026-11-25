import {
  canQueueWorkspaceCleanupCandidate,
  needsWorkspaceCleanupRemovalApproval,
  type WorkspaceCleanupCandidate
} from './workspace-cleanup'

export const WORKSPACE_CLEANUP_GROUPS = ['nothing-local', 'local-files', 'cannot-delete'] as const

export type WorkspaceCleanupGroup = (typeof WORKSPACE_CLEANUP_GROUPS)[number]

/** Rows delete cannot queue first, then rows whose removal needs approval; the rest hold nothing local. */
export function getWorkspaceCleanupGroup(
  candidate: Pick<WorkspaceCleanupCandidate, 'blockers' | 'git'>
): WorkspaceCleanupGroup {
  if (!canQueueWorkspaceCleanupCandidate(candidate)) {
    return 'cannot-delete'
  }
  return needsWorkspaceCleanupRemovalApproval(candidate) ? 'local-files' : 'nothing-local'
}
