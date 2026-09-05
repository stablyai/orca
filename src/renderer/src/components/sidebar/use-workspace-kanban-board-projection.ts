import { useLayoutEffect, useMemo } from 'react'
import type { useAppStore } from '@/store'
import { useVisibleWorkspaceKanbanWorktreeIds } from './use-visible-workspace-kanban-worktree-ids'
import { groupWorkspaceKanbanWorktrees } from './workspace-kanban-worktree-groups'
import { buildWorkspaceKanbanLaneViews } from './workspace-kanban-search'
import { useWorkspaceKanbanSearch } from './use-workspace-kanban-search'
import { registerWorkspaceKanbanSidebarDropGroups } from './workspace-kanban-sidebar-drop'
import { buildUnambiguousWorktreeIdIndex } from './worktree-unambiguous-id-index'
import {
  composeWorktreeHostIdentity,
  getWorktreeHostIdentity
} from '../../../../shared/worktree/host-qualified-identity'
import type { Worktree } from '../../../../shared/worktree/types'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import { parseWorkspaceKey } from '../../../../shared/workspace-scope'
import type { WorktreeDragGroup } from './worktree-manual-order'
import type { useRepoMap } from '@/store/selectors'

function isFolderWorkspaceEntry(worktree: Worktree): boolean {
  return parseWorkspaceKey(worktree.id)?.type === 'folder'
}

export function useWorkspaceKanbanBoardProjection(args: {
  activeWorktreeId: string | null
  activeWorkspaceExecutionHostId: ExecutionHostId | null
  allWorktrees: readonly Worktree[]
  open: boolean
  repoMap: ReturnType<typeof useRepoMap>
  sortBy: ReturnType<typeof useAppStore.getState>['sortBy']
  workspaceStatuses: ReturnType<typeof useAppStore.getState>['workspaceStatuses']
}) {
  // Why: the visibility filters (default branch, detached HEAD, other devices…)
  // describe git checkouts. A folder workspace entry has no branch or repo, so
  // it is on the board whenever it is in the list — archiving is the only
  // thing that removes it, and the list builder already honours that.
  const gitWorktrees = useMemo(
    () => args.allWorktrees.filter((worktree) => !isFolderWorkspaceEntry(worktree)),
    [args.allWorktrees]
  )
  const visibleGitWorktreeIds = useVisibleWorkspaceKanbanWorktreeIds({
    allWorktrees: gitWorktrees,
    repoMap: args.repoMap
  })
  const visibleWorktreeIds = useMemo(
    () =>
      new Set([
        ...visibleGitWorktreeIds,
        ...args.allWorktrees.filter(isFolderWorkspaceEntry).map(getWorktreeHostIdentity)
      ]),
    [args.allWorktrees, visibleGitWorktreeIds]
  )
  const worktreesByStatus = useMemo(
    () =>
      groupWorkspaceKanbanWorktrees({
        worktrees: args.allWorktrees,
        visibleWorktreeIds,
        workspaceStatuses: args.workspaceStatuses,
        sortBy: args.sortBy
      }),
    [args.allWorktrees, args.sortBy, args.workspaceStatuses, visibleWorktreeIds]
  )
  const worktreeById = useMemo(
    () => buildUnambiguousWorktreeIdIndex(args.allWorktrees),
    [args.allWorktrees]
  )
  const boardWorktrees = useMemo(
    () => args.workspaceStatuses.flatMap((status) => worktreesByStatus.get(status.id) ?? []),
    [args.workspaceStatuses, worktreesByStatus]
  )
  const boardDragGroups = useMemo<WorktreeDragGroup[]>(
    () =>
      args.workspaceStatuses.map((status) => ({
        key: status.id,
        worktreeIds: (worktreesByStatus.get(status.id) ?? []).map((worktree) => worktree.id)
      })),
    [args.workspaceStatuses, worktreesByStatus]
  )
  useLayoutEffect(() => {
    if (!args.open) {
      return
    }
    return registerWorkspaceKanbanSidebarDropGroups(boardDragGroups)
  }, [args.open, boardDragGroups])
  const laneFullWorktreeIds = useMemo(
    () => new Map(boardDragGroups.map((group) => [group.key, group.worktreeIds])),
    [boardDragGroups]
  )
  const search = useWorkspaceKanbanSearch({
    open: args.open,
    worktrees: boardWorktrees,
    repoMap: args.repoMap
  })
  const laneViews = useMemo(
    () =>
      buildWorkspaceKanbanLaneViews({
        worktreesByStatus,
        matchingWorktreeIds: search.matchingWorktreeIds
      }),
    [search.matchingWorktreeIds, worktreesByStatus]
  )
  const renderedBoardWorktrees = useMemo(
    () =>
      search.matchingWorktreeIds
        ? boardWorktrees.filter((worktree) =>
            search.matchingWorktreeIds?.has(getWorktreeHostIdentity(worktree))
          )
        : boardWorktrees,
    [boardWorktrees, search.matchingWorktreeIds]
  )
  const activeWorktreeIdentity = args.activeWorktreeId
    ? composeWorktreeHostIdentity(
        args.activeWorkspaceExecutionHostId ?? undefined,
        args.activeWorktreeId
      )
    : null
  return {
    activeWorktreeIdentity,
    boardDragGroups,
    boardWorktrees,
    laneFullWorktreeIds,
    laneViews,
    renderedBoardWorktrees,
    search,
    worktreeById,
    worktreesByStatus
  }
}
