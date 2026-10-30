import type { Worktree } from '../../../../shared/worktree/types'
import type { WorktreeRemovalTarget } from '../../../../shared/worktree/removal'
import type { WorktreeDeleteIdentity } from './worktree-delete-request'
import { runWorktreeDeletesInParallel } from './delete-worktree-flow'
import type { ConfirmedUnsavedDiscards } from '@/store/slices/worktrees/teardown/removed-workspace-unsaved-files'

/** The modal confirms the whole lineage; delete children without repeat prompts and show progress on their cards. */
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
