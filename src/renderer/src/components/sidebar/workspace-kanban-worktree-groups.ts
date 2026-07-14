import type { WorkspaceStatus, WorkspaceStatusDefinition, Worktree } from '../../../../shared/types'
import type { SortBy } from './smart-sort'
import { getWorkspaceStatus } from './workspace-status'

// Why: displayName is typed non-optional, but persisted/discovered worktrees
// have reached the sidebar with an undefined name (crash 99657ab1), which made
// `displayName.localeCompare(...)` throw and took down the sidebar. Compare on a
// safe string so a missing name only affects tie-break order, never crashes.
function compareDisplayName(a: Worktree, b: Worktree): number {
  return (a.displayName ?? '').localeCompare(b.displayName ?? '')
}

function sortBoardWorktrees(a: Worktree, b: Worktree): number {
  return b.lastActivityAt - a.lastActivityAt || compareDisplayName(a, b)
}

function sortManualBoardWorktrees(a: Worktree, b: Worktree): number {
  return (b.manualOrder ?? b.sortOrder) - (a.manualOrder ?? a.sortOrder) || compareDisplayName(a, b)
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
  }
  return grouped
}
