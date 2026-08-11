import type { Repo, Worktree } from '../../../../shared/types'
import type { WorktreeDeleteState } from '../../store/slices/worktree-helpers'
import { isFolderWorkspaceDelete } from './delete-worktree-dialog-copy'

export function getDeleteWorktreeDirtyChangeCounts({
  deleteTargets,
  deleteStateByWorktreeId,
  gitStatusByWorktree,
  repoMap
}: {
  deleteTargets: readonly Worktree[]
  deleteStateByWorktreeId: Record<string, WorktreeDeleteState | undefined>
  gitStatusByWorktree: Record<string, readonly unknown[] | undefined>
  repoMap: ReadonlyMap<string, Repo>
}): Map<string, number> {
  const result = new Map<string, number>()
  for (const item of deleteTargets) {
    if (item.isMainWorktree || isFolderWorkspaceDelete(repoMap, item)) {
      continue
    }
    const forceDeleteReason = deleteStateByWorktreeId[item.id]?.forceDeleteReason
    const changeCount = gitStatusByWorktree[item.id]?.length
    if ((changeCount ?? 0) > 0) {
      result.set(item.id, changeCount ?? 0)
    } else if (forceDeleteReason === 'dirty') {
      // Why: Git proved the worktree dirty even when renderer status has not
      // loaded; keep the warning visible without inventing a file count.
      result.set(item.id, 0)
    }
  }
  return result
}
