import type { WorkspaceStatus, WorkspaceStatusDefinition, Worktree } from '../../../../shared/types'
import { getWorkspaceStatus } from './workspace-status'

function sortBoardWorktrees(a: Worktree, b: Worktree): number {
  return b.lastActivityAt - a.lastActivityAt || a.displayName.localeCompare(b.displayName)
}

export function groupWorkspaceKanbanWorktrees(params: {
  worktrees: readonly Worktree[]
  visibleWorktreeIds: ReadonlySet<string>
  workspaceStatuses: readonly WorkspaceStatusDefinition[]
}): Map<WorkspaceStatus, Worktree[]> {
  const { worktrees, visibleWorktreeIds, workspaceStatuses } = params
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
    items.sort((a, b) => Number(b.isPinned) - Number(a.isPinned) || sortBoardWorktrees(a, b))
  }
  return grouped
}
