import type { Repo } from '../../../../shared/repo-types'
import type { GitFileStatus, GitStatusEntry } from '../../../../shared/git-status-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { getWorktreeHostIdentity } from '../../../../shared/worktree/host-qualified-identity'
import type { WorktreeDeleteState } from '../../store/slices/worktree-helpers'
import { buildStatusMap } from '../right-sidebar/status-display'
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

export type DeleteWorktreeDirtyFile = { path: string; status: GitFileStatus }

// Why: staged and unstaged edits to one path are separate entries; list each file once.
export function getDeleteWorktreeDirtyFiles(
  entries: readonly GitStatusEntry[]
): DeleteWorktreeDirtyFile[] {
  return Array.from(buildStatusMap(entries), ([path, status]) => ({ path, status }))
}

export function getDeleteWorktreeDirtyChanges({
  deleteTargets,
  deleteStateByWorktreeId,
  gitStatusByWorktree,
  gitStatusByWorktreeIdentity,
  repoMap
}: {
  deleteTargets: readonly Worktree[]
  deleteStateByWorktreeId: Record<string, WorktreeDeleteState | undefined>
  gitStatusByWorktree: Record<string, readonly GitStatusEntry[] | undefined>
  gitStatusByWorktreeIdentity?: ReadonlyMap<string, readonly GitStatusEntry[]>
  repoMap: ReadonlyMap<string, Repo>
}): Map<string, DeleteWorktreeDirtyFile[]> {
  const result = new Map<string, DeleteWorktreeDirtyFile[]>()
  for (const item of deleteTargets) {
    if (item.isMainWorktree || isFolderWorkspaceDelete(repoMap, item)) {
      continue
    }
    const resultKey = item.hostId ? getWorktreeHostIdentity(item) : item.id
    const forceDeleteReason = getDeleteStateForWorktreeHost(
      item,
      deleteStateByWorktreeId
    )?.forceDeleteReason
    const entries = item.hostId
      ? gitStatusByWorktreeIdentity?.get(getWorktreeHostIdentity(item))
      : gitStatusByWorktree[item.id]
    if (entries && entries.length > 0) {
      result.set(resultKey, getDeleteWorktreeDirtyFiles(entries))
    } else if (forceDeleteReason === 'dirty') {
      // Why: Git proved the worktree dirty even when renderer status has not
      // loaded; keep the warning visible without inventing a file list.
      result.set(resultKey, [])
    }
  }
  return result
}
