import type { WorkspaceCleanupCandidate } from '../../../../shared/workspace-cleanup'
import { getWorkspaceCleanupCandidateIdentity } from '../../../../shared/workspace-cleanup-host-identity'
import { prepareActiveWorktreeFocusAfterDelete } from '../sidebar/active-worktree-focus-after-delete'
import type { WorkspaceCleanupBackgroundRemovalArgs } from './workspace-cleanup-background-removal'

type RemoveCandidates = WorkspaceCleanupBackgroundRemovalArgs['removeCandidates']

/**
 * Runs the sidebar delete's focus hand-off for each confirmed row as soon as that row's own
 * removal succeeds, including one that settles after the batch's timeout. A failed row never
 * hands off, like a failed sidebar delete.
 */
export function withWorkspaceCleanupFocusAfterDelete(
  removeCandidates: RemoveCandidates,
  candidates: readonly WorkspaceCleanupCandidate[]
): RemoveCandidates {
  return async (worktreeIds, options) => {
    const candidate = (options?.approvedCandidates ?? candidates).find((row) =>
      worktreeIds.includes(row.worktreeId)
    )
    const commit = candidate
      ? prepareActiveWorktreeFocusAfterDelete(candidate.worktreeId)
      : undefined
    const result = await removeCandidates(worktreeIds, options)
    if (
      candidate &&
      result.removedIdentities.includes(getWorkspaceCleanupCandidateIdentity(candidate))
    ) {
      try {
        commit?.()
      } catch (error) {
        // Why: the row is already deleted; a focus failure must not report it as failed.
        console.error('Could not move focus after deleting a workspace', error)
      }
    }
    return result
  }
}
