import type { WorkspaceStatus, WorkspaceStatusDefinition, Worktree } from '../../../../shared/types'
import type { SortBy } from './smart-sort'
import { getWorkspaceStatus } from './workspace-status'

function sortBoardWorktrees(a: Worktree, b: Worktree): number {
  return b.lastActivityAt - a.lastActivityAt || a.displayName.localeCompare(b.displayName)
}

function sortManualBoardWorktrees(a: Worktree, b: Worktree): number {
  return (
    (b.manualOrder ?? b.sortOrder) - (a.manualOrder ?? a.sortOrder) ||
    a.displayName.localeCompare(b.displayName)
  )
}

export function groupWorkspaceKanbanWorktrees(params: {
  worktrees: readonly Worktree[]
  visibleWorktreeIds: ReadonlySet<string>
  workspaceStatuses: readonly WorkspaceStatusDefinition[]
  sortBy: SortBy
}): Map<WorkspaceStatus, Worktree[]> {
  const { worktrees, visibleWorktreeIds, workspaceStatuses, sortBy } = params
  const grouped = new Map<WorkspaceStatus, Worktree[]>(
    workspaceStatuses.map((status) => [status.id, []])
  )

  for (const worktree of worktrees) {
    if (!visibleWorktreeIds.has(worktree.id)) {
      continue
    }
    grouped.get(getWorkspaceStatus(worktree, workspaceStatuses))!.push(worktree)
  }

  for (const items of grouped.values()) {
    items.sort(
      sortBy === 'manual'
        ? sortManualBoardWorktrees
        : (a, b) => Number(b.isPinned) - Number(a.isPinned) || sortBoardWorktrees(a, b)
    )
    clusterByWorkspaceGroup(items)
  }
  return grouped
}

export function clusterByWorkspaceGroup(items: Worktree[]): void {
  if (items.length < 2) {
    return
  }
  const seenGroups = new Set<string>()
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!
    if (item.isPinned) {
      continue
    }
    const groupId = item.workspaceGroupId
    if (!groupId || seenGroups.has(groupId)) {
      continue
    }
    seenGroups.add(groupId)
    let insertAt = i + 1
    for (let j = i + 1; j < items.length; j++) {
      const candidate = items[j]!
      if (candidate.isPinned) {
        continue
      }
      if (candidate.workspaceGroupId === groupId) {
        if (j !== insertAt) {
          const moved = items.splice(j, 1)[0]!
          items.splice(insertAt, 0, moved)
        }
        insertAt++
      }
    }
  }
}
