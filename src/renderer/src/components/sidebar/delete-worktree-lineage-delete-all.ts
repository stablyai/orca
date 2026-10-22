import type { Worktree } from '../../../../shared/worktree/types'
import type { WorktreeRemovalTarget } from '../../../../shared/worktree/removal'
import type { WorktreeDeleteIdentity } from './worktree-delete-request'
import { runWorktreeDeletesInParallel } from './delete-worktree-flow'
import type { ConfirmedUnsavedDiscards } from '@/store/slices/worktrees/teardown/removed-workspace-unsaved-files'

/**
 * "Delete all" for a lineage: the modal already confirmed every affected
 * workspace, so children do not raise their own force prompts, and the modal
 * closes because progress is shown on the workspace cards instead.
 */
export function runLineageDeleteAll(args: {
  deleteAllTargetCount: number
  lineageDeleteIdentities: readonly WorktreeDeleteIdentity[]
  resolveConfirmedTargets: (
    identities: readonly WorktreeDeleteIdentity[],
    expectedCount: number
  ) => Worktree[] | null
  forceOnConfirm: boolean
  onForceDeleted: (target: WorktreeRemovalTarget) => void
  closeModal: () => void
  onDeleted: ((deleted: WorktreeRemovalTarget[]) => void) | null | undefined
  confirmedDiscards: ConfirmedUnsavedDiscards
}): void {
  if (args.deleteAllTargetCount <= 1) {
    return
  }
  const currentTargets = args.resolveConfirmedTargets(
    args.lineageDeleteIdentities,
    args.deleteAllTargetCount
  )
  if (!currentTargets) {
    return
  }
  const deletePromise = runWorktreeDeletesInParallel(currentTargets, {
    force: args.forceOnConfirm,
    onForceDeleted: args.onForceDeleted,
    confirmedDiscards: args.confirmedDiscards
  })
  args.closeModal()
  void deletePromise.then((deletedTargets) => {
    if (deletedTargets.length > 0) {
      args.onDeleted?.(deletedTargets)
    }
  })
}
