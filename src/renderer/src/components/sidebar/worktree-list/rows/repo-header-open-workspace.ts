import { useAppStore } from '@/store'
import { activateWorktreeFromSidebar } from '@/lib/sidebar-worktree-activation'
import type { GroupHeaderRow } from '../../../../../../shared/sidebar-list/row-types'
import type { Worktree } from '../../../../../../shared/worktree/types'

// Prefer the primary checkout, then the most recently active workspace.
export function pickRepoHeaderWorkspace(
  worktrees: readonly Worktree[],
  row: Pick<GroupHeaderRow, 'hostId' | 'worktreeIds'>
): Worktree | null {
  const visibleIds = row.worktreeIds ? new Set(row.worktreeIds) : null
  const candidates = worktrees.filter(
    (worktree) =>
      !worktree.isArchived &&
      (!row.hostId || !worktree.hostId || worktree.hostId === row.hostId) &&
      (!visibleIds || visibleIds.size === 0 || visibleIds.has(worktree.id))
  )
  return (
    candidates.find((worktree) => worktree.isMainWorktree) ??
    [...candidates].sort((a, b) => b.lastActivityAt - a.lastActivityAt)[0] ??
    null
  )
}

// Returns false when the setting is off or the project has no workspace, so the caller can fall back to collapse.
export function openRepoHeaderWorkspace(row: GroupHeaderRow): boolean {
  const state = useAppStore.getState()
  if (state.settings?.projectHeaderClickOpensWorkspace !== true || !row.repo) {
    return false
  }
  const target = pickRepoHeaderWorkspace(state.worktreesByRepo[row.repo.id] ?? [], row)
  if (!target) {
    return false
  }
  void activateWorktreeFromSidebar(target.id, target.hostId ?? row.hostId)
  return true
}

// Header click: open the project's workspace when opted in, else collapse/expand.
export function activateSectionHeader(
  row: GroupHeaderRow,
  isRepoHeader: boolean,
  toggle: () => void
): void {
  if (isRepoHeader && openRepoHeaderWorkspace(row)) {
    return
  }
  toggle()
}
