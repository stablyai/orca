import { useLayoutEffect, useMemo } from 'react'
import { useAppStore } from '@/store'
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
import {
  ALL_EXECUTION_HOSTS_SCOPE,
  LOCAL_EXECUTION_HOST_ID,
  type ExecutionHostId
} from '../../../../shared/execution-host'
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
  // archiving — which the list builder already honours — and the host filter
  // below are the only things that remove it.
  const gitWorktrees = useMemo(
    () => args.allWorktrees.filter((worktree) => !isFolderWorkspaceEntry(worktree)),
    [args.allWorktrees]
  )
  const visibleGitWorktreeIds = useVisibleWorkspaceKanbanWorktreeIds({
    allWorktrees: gitWorktrees,
    repoMap: args.repoMap
  })
  const workspaceHostScope = useAppStore((s) => s.workspaceHostScope)
  const visibleWorkspaceHostIds = useAppStore((s) => s.visibleWorkspaceHostIds)
  // Why: a folder workspace does execute on one host, so it answers to the host
  // filter exactly as computeVisibleWorktrees makes a git worktree answer to it.
  const visibleFolderWorktreeIds = useMemo(() => {
    const visibleHostIds =
      visibleWorkspaceHostIds ??
      (workspaceHostScope === ALL_EXECUTION_HOSTS_SCOPE ? null : [workspaceHostScope])
    const visibleHostIdSet = visibleHostIds ? new Set(visibleHostIds) : null
    return args.allWorktrees
      .filter(
        (worktree) =>
          isFolderWorkspaceEntry(worktree) &&
          (!visibleHostIdSet || visibleHostIdSet.has(worktree.hostId ?? LOCAL_EXECUTION_HOST_ID))
      )
      .map(getWorktreeHostIdentity)
  }, [args.allWorktrees, visibleWorkspaceHostIds, workspaceHostScope])
  const visibleWorktreeIds = useMemo(
    () => new Set([...visibleGitWorktreeIds, ...visibleFolderWorktreeIds]),
    [visibleFolderWorktreeIds, visibleGitWorktreeIds]
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
