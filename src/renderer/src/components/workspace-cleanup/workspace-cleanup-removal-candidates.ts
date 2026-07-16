import type { WorkspaceCleanupCandidate } from '../../../../shared/workspace-cleanup'
import type { WorktreeDeleteState } from '@/store/slices/worktrees'

type DeletionFlagState = Pick<WorktreeDeleteState, 'isDeleting'>

export function filterWorkspaceCleanupRemovalCandidates(
  candidates: readonly WorkspaceCleanupCandidate[],
  deleteStateByWorktreeId: Record<string, DeletionFlagState | undefined>
): WorkspaceCleanupCandidate[] {
  return candidates.filter(
    (candidate) => deleteStateByWorktreeId[candidate.worktreeId]?.isDeleting !== true
  )
}
