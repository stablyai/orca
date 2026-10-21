import type { RemoveWorktreeResult } from '../../../../../../shared/worktree/create-types'
import type { Worktree } from '../../../../../../shared/worktree/types'
import type { WorktreeSlice } from '../../worktree-helpers'
import type { WorktreeSliceGet } from '../listing/worktree-slice-types'
import { showPreservedBranchToast } from '@/components/sidebar/preserved-branch-toast'

export async function completePreservedBranchCleanup({
  get,
  worktreeId,
  removalResult,
  worktreeBeforeRemoval,
  branchCleanupOptions,
  suppressToast
}: {
  get: WorktreeSliceGet
  worktreeId: string
  removalResult: RemoveWorktreeResult | undefined
  worktreeBeforeRemoval: Pick<Worktree, 'displayName' | 'isMainWorktree'> | undefined
  branchCleanupOptions: NonNullable<Parameters<WorktreeSlice['forceDeletePreservedBranch']>[3]>
  suppressToast: boolean
}): Promise<boolean> {
  const preservedBranch = removalResult?.preservedBranch
  if (!preservedBranch) {
    return false
  }
  const autoDeleted =
    preservedBranch.head && get().settings?.alwaysForceDeletePreservedBranches === true
      ? (
          await get().forceDeletePreservedBranch(
            worktreeId,
            preservedBranch.branchName,
            preservedBranch.head,
            { ...branchCleanupOptions, suppressToast: true }
          )
        ).ok
      : false
  if (!autoDeleted && !suppressToast) {
    showPreservedBranchToast(
      removalResult,
      worktreeBeforeRemoval,
      (branch, expectedHead) => {
        void get().forceDeletePreservedBranch(
          worktreeId,
          branch,
          expectedHead,
          branchCleanupOptions
        )
      },
      () => get().updateSettingsOrThrow({ alwaysForceDeletePreservedBranches: true })
    )
  }
  return autoDeleted
}
