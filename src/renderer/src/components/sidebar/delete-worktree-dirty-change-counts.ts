import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { getWorktreeHostIdentity } from '../../../../shared/worktree/host-qualified-identity'
import type { WorktreeDeleteState } from '../../store/slices/worktree-helpers'
import { isFolderWorkspaceDelete } from './delete-worktree-dialog-copy'

export function orderDeleteWorktreeStatusHydrationTargets({
  targets,
  visibleTargets,
  activeWorktreeId,
  activeExecutionHostId
}: {
  targets: readonly Worktree[]
  visibleTargets: readonly Worktree[]
  activeWorktreeId: string | null
  activeExecutionHostId: string | null
}): Worktree[] {
  const visibleIdentities = new Set(visibleTargets.map(getWorktreeHostIdentity))
  return targets
    .map((target, index) => {
      const isActive =
        target.id === activeWorktreeId &&
        (!activeExecutionHostId || (target.hostId ?? 'local') === activeExecutionHostId)
      const rank = isActive ? 0 : visibleIdentities.has(getWorktreeHostIdentity(target)) ? 1 : 2
      return { target, index, rank }
    })
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .map(({ target }) => target)
}
import { getDeleteStateForWorktreeHost } from './worktree-delete-state-host-match'

export function getDeleteWorktreeDirtyChangeCounts({
  deleteTargets,
  deleteStateByWorktreeId,
  gitStatusByWorktree,
  gitStatusByWorktreeIdentity,
  repoMap
}: {
  deleteTargets: readonly Worktree[]
  deleteStateByWorktreeId: Record<string, WorktreeDeleteState | undefined>
  gitStatusByWorktree: Record<string, readonly unknown[] | undefined>
  gitStatusByWorktreeIdentity?: ReadonlyMap<string, readonly unknown[]>
  repoMap: ReadonlyMap<string, Repo>
}): Map<string, number> {
  const result = new Map<string, number>()
  for (const item of deleteTargets) {
    if (item.isMainWorktree || isFolderWorkspaceDelete(repoMap, item)) {
      continue
    }
    const resultKey = item.hostId ? getWorktreeHostIdentity(item) : item.id
    const forceDeleteReason = getDeleteStateForWorktreeHost(
      item,
      deleteStateByWorktreeId
    )?.forceDeleteReason
    const changeCount = (
      item.hostId
        ? gitStatusByWorktreeIdentity?.get(getWorktreeHostIdentity(item))
        : gitStatusByWorktree[item.id]
    )?.length
    if ((changeCount ?? 0) > 0) {
      result.set(resultKey, changeCount ?? 0)
    } else if (forceDeleteReason === 'dirty') {
      // Why: Git proved the worktree dirty even when renderer status has not
      // loaded; keep the warning visible without inventing a file count.
      result.set(resultKey, 0)
    }
  }
  return result
}
