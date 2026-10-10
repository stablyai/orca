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
  const commitByIdentity = new Map(
    candidates.map((candidate) => [
      getWorkspaceCleanupCandidateIdentity(candidate),
      prepareActiveWorktreeFocusAfterDelete(candidate.worktreeId)
    ])
  )
  return async (worktreeIds, options) => {
    const result = await removeCandidates(worktreeIds, options)
    for (const identity of result.removedIdentities) {
      const commit = commitByIdentity.get(identity)
      commitByIdentity.delete(identity)
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
