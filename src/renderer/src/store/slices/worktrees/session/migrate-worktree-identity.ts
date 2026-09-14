import type { WorktreeSlice } from '../../worktree-helpers'
import type { WorktreeSliceGet, WorktreeSliceSet } from '../listing/worktree-slice-types'
import { migrateHugeRepoWarningDismissal } from '@/lib/source-control-huge-repo-warning-dismissals'
import { migrateHostedReviewLinkMutationGeneration } from '../metadata/hosted-review-link-mutation'
import { buildWorktreeRenameState } from './worktree-identity-rename-state'

export function createMigrateWorktreeIdentity(
  set: WorktreeSliceSet,
  _get: WorktreeSliceGet
): WorktreeSlice['migrateWorktreeIdentity'] {
  return (oldWorktreeId: string, newWorktreeId: string) => {
    if (oldWorktreeId === newWorktreeId) {
      return
    }
    // Why: invalidate pre-rename toast actions before publishing the new path, carrying the dismissal forward.
    migrateHugeRepoWarningDismissal(oldWorktreeId, newWorktreeId)
    set((s) => buildWorktreeRenameState(s, oldWorktreeId, newWorktreeId))
    migrateHostedReviewLinkMutationGeneration(oldWorktreeId, newWorktreeId)
  }
}
