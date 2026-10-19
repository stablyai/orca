import type { SidebarListModel, SidebarListModelArgs } from './sidebar-list-model'
import { useSidebarExternalWorktreeCards } from './use-external-worktree-cards'
import { useSidebarHostVisibleScope } from './use-host-visible-scope'
import { useSidebarSectionRows } from './use-section-rows'
import { useSidebarWorktreeSortOrder } from './use-sort-order'
import { useOrderHeldWhileEngaged } from './use-order-hold'
import { useVisibleSidebarWorktrees } from './use-visible-worktrees'

/** The list the window derives from its own store; the only one a switch-off build has. */
export function useWindowSidebarListModel(args: SidebarListModelArgs): SidebarListModel {
  const { filterState, sortBy, repoMap, repos, defaultHostId } = args
  const sortedIds = useOrderHeldWhileEngaged(
    useSidebarWorktreeSortOrder({ repoMap, sortBy }),
    sortBy
  )
  const { visibleWorktrees, pairedDeviceIdsByEnvironment } = useVisibleSidebarWorktrees({
    filterState,
    sortBy,
    sortedIds,
    repoMap,
    worktreeLineageById: args.worktreeLineageById,
    defaultHostId,
    agentSendTargetWorktreeId: args.agentSendTargetWorktreeId
  })
  const visibleScope = useSidebarHostVisibleScope({
    filterState,
    defaultHostId,
    repos,
    projectGroups: args.projectGroups,
    folderWorkspaces: args.folderWorkspaces,
    pairedDeviceIdsByEnvironment
  })
  const externalWorktreeCards = useSidebarExternalWorktreeCards({
    repos,
    visibleReposForRows: visibleScope.visibleReposForRows,
    detectedWorktreesByRepo: args.detectedWorktreesByRepo,
    filterRepoIds: filterState.filterRepoIds
  })
  const rowModel = useSidebarSectionRows({
    groupBy: args.groupBy,
    projectOrderBy: args.projectOrderBy,
    pinnedDisplayPolicy: args.pinnedDisplayPolicy,
    defaultHostId,
    worktrees: visibleWorktrees,
    repos,
    repoMap,
    worktreeMap: args.worktreeMap,
    worktreeLineageById: args.worktreeLineageById,
    prCache: args.prCache,
    settings: args.settings,
    workspaceStatuses: args.workspaceStatuses,
    effectiveCollapsedGroups: args.collapsedGroups,
    agentSendTargetWorktreeId: args.agentSendTargetWorktreeId,
    projectGrouping: args.projectGrouping,
    visibleReposForRows: visibleScope.visibleReposForRows,
    visibleProjectGroupsForRows: visibleScope.visibleProjectGroupsForRows,
    visibleFolderWorkspacesForRows: visibleScope.visibleFolderWorkspacesForRows,
    importedWorktreesByRepo: externalWorktreeCards.importedWorktreesByRepo,
    newExternalWorktreesInboxByRepo: externalWorktreeCards.newExternalWorktreesInboxByRepo,
    filterRepoIds: filterState.filterRepoIds,
    visibleWorkspaceHostIds: filterState.visibleWorkspaceHostIds,
    workspaceHostScope: filterState.workspaceHostScope
  })
  return { visibleWorktrees, visibleScope, externalWorktreeCards, rowModel }
}
