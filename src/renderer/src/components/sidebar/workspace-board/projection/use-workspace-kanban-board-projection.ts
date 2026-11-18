import { useLayoutEffect, useMemo } from 'react'
import { useAppStore } from '@/store'
import { selectFolderWorkspaces } from '@/store/workspaces/catalog/workspace-record-fields'
import { selectSidebarChildrenByParentIdentity } from '@/store/slices/worktrees/metadata/cross-store-lineage-parents'
import { getVisibleSidebarHostIdSet } from '../../../../../../shared/sidebar-list/hosts/host-filtering'
import { projectWorkspaceBoardFolders } from './workspace-board-folder-cards'
import { useVisibleWorkspaceKanbanWorktreeIds } from '../surface/use-visible-workspace-kanban-worktree-ids'
import { groupWorkspaceKanbanWorktrees } from './workspace-kanban-worktree-groups'
import { buildWorkspaceKanbanLaneViews } from '../search/workspace-kanban-search'
import { useWorkspaceKanbanSearch } from '../search/use-workspace-kanban-search'
import { registerWorkspaceKanbanSidebarDropGroups } from '../drag/workspace-kanban-sidebar-drop'
import { buildUnambiguousWorktreeIdIndex } from '../../worktree-list/navigation/worktree-unambiguous-id-index'
import {
  composeWorktreeHostIdentity,
  getWorktreeHostIdentity
} from '../../../../../../shared/worktree/host-qualified-identity'
import type { WorkspaceStatusDefinition, Worktree } from '../../../../../../shared/worktree/types'
import type { ExecutionHostId } from '../../../../../../shared/execution-host/execution-host'
import type { WorktreeDragGroup } from '../../worktree-list/drag/worktree-manual-order'
import type { useRepoMap } from '@/store/repos/use-repository-catalog'

export function useWorkspaceKanbanBoardProjection(args: {
  activeWorktreeId: string | null
  activeWorkspaceExecutionHostId: ExecutionHostId | null
  allWorktrees: readonly Worktree[]
  open: boolean
  repoMap: ReturnType<typeof useRepoMap>
  sortBy: ReturnType<typeof useAppStore.getState>['sortBy']
  workspaceStatuses: readonly WorkspaceStatusDefinition[]
}) {
  const folders = useAppStore(selectFolderWorkspaces)
  const childrenByParentIdentity = useAppStore(selectSidebarChildrenByParentIdentity)
  const workspaceHostScope = useAppStore((s) => s.workspaceHostScope)
  const visibleWorkspaceHostIds = useAppStore((s) => s.visibleWorkspaceHostIds)
  const visibleGitIdentities = useVisibleWorkspaceKanbanWorktreeIds({
    allWorktrees: args.allWorktrees,
    repoMap: args.repoMap
  })
  const folderProjection = useMemo(
    () =>
      projectWorkspaceBoardFolders({
        folders,
        childrenByParentIdentity,
        visibleHostIds: getVisibleSidebarHostIdSet(visibleWorkspaceHostIds, workspaceHostScope),
        visibleGitIdentities
      }),
    [
      folders,
      childrenByParentIdentity,
      visibleWorkspaceHostIds,
      workspaceHostScope,
      visibleGitIdentities
    ]
  )
  const allBoardCandidates = useMemo(
    () => [...args.allWorktrees, ...folderProjection.folders],
    [args.allWorktrees, folderProjection.folders]
  )
  const worktreesByStatus = useMemo(
    () =>
      groupWorkspaceKanbanWorktrees({
        worktrees: allBoardCandidates,
        visibleWorktreeIds: folderProjection.visibleIdentities,
        workspaceStatuses: args.workspaceStatuses,
        sortBy: args.sortBy
      }),
    [allBoardCandidates, args.sortBy, args.workspaceStatuses, folderProjection.visibleIdentities]
  )
  const worktreeById = useMemo(
    () => buildUnambiguousWorktreeIdIndex(allBoardCandidates),
    [allBoardCandidates]
  )
  // Drops carry each card's host identity, so same-id copies on two hosts stay separate cards.
  const worktreeByKey = useMemo(
    () =>
      new Map(allBoardCandidates.map((worktree) => [getWorktreeHostIdentity(worktree), worktree])),
    [allBoardCandidates]
  )
  const boardWorktrees = useMemo(
    () => args.workspaceStatuses.flatMap((status) => worktreesByStatus.get(status.id) ?? []),
    [args.workspaceStatuses, worktreesByStatus]
  )
  // Lane members are host identities, as in the sidebar's drag groups.
  const boardDragGroups = useMemo<WorktreeDragGroup[]>(
    () =>
      args.workspaceStatuses.map((status) => ({
        key: status.id,
        worktreeIds: (worktreesByStatus.get(status.id) ?? []).map(getWorktreeHostIdentity)
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
    worktreeByKey,
    worktreesByStatus
  }
}
