import type {
  WorkspaceStatus,
  WorkspaceStatusDefinition,
  Worktree
} from '../../../../../../shared/worktree/types'
import type { WorkspaceSortBy as SortBy } from '../../../../../../shared/workspace-view/workspace-row-sort'
import '../../workspace-status/presentation/workspace-status'
import { getPlacedWorkspaceStatus } from '../../../../../../shared/workspace/status/workspace-status-placement'
import { getVisibleLineageAncestorRoots } from '../../../../../../shared/sidebar-list/lineage/worktree-lineage-placement'
import { compareWorktreeDisplayName } from '../../../../../../shared/worktree/display-name-order'
import { getWorktreeHostIdentity } from '../../../../../../shared/worktree/host-qualified-identity'

function sortBoardWorktrees(a: Worktree, b: Worktree): number {
  return b.lastActivityAt - a.lastActivityAt || compareWorktreeDisplayName(a, b)
}

function sortManualBoardWorktrees(a: Worktree, b: Worktree): number {
  return (
    (b.manualOrder ?? b.sortOrder) - (a.manualOrder ?? a.sortOrder) ||
    compareWorktreeDisplayName(a, b)
  )
}

export function groupWorkspaceKanbanWorktrees(params: {
  worktrees: readonly Worktree[]
  visibleWorktreeIds: ReadonlySet<string>
  workspaceStatuses: readonly WorkspaceStatusDefinition[]
  sortBy: SortBy
  /** Children by parent host identity, as the sidebar nests them. */
  childrenByParentIdentity?: ReadonlyMap<string, readonly Worktree[]>
}): Map<WorkspaceStatus, Worktree[]> {
  const { worktrees, visibleWorktreeIds, workspaceStatuses, sortBy } = params
  const grouped = new Map<WorkspaceStatus, Worktree[]>(
    workspaceStatuses.map((status) => [status.id, []])
  )
  const visible = worktrees.filter((worktree) =>
    visibleWorktreeIds.has(getWorktreeHostIdentity(worktree))
  )
  // Cards follow their top shown ancestor's lane, as sidebar rows do.
  const displayRoots = getVisibleLineageAncestorRoots(
    visible,
    params.childrenByParentIdentity ?? new Map(),
    getWorktreeHostIdentity
  )
  for (const worktree of visible) {
    const root = displayRoots.get(getWorktreeHostIdentity(worktree))
    grouped.get(getPlacedWorkspaceStatus(worktree, root, workspaceStatuses))!.push(worktree)
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
