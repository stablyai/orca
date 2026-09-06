import React, { useCallback, useMemo } from 'react'
import { useAppStore } from '@/store'
import { useShallow } from 'zustand/react/shallow'
import {
  useAllWorktrees,
  useProjectHostSetupProjection,
  useRepoMap,
  useWorktreeMap
} from '@/store/selectors'
import type { ProjectGroup } from '../../../../shared/project-group-types'
import type { Repo } from '../../../../shared/repo-types'
import {
  getRepoExecutionHostId,
  getSettingsFocusedExecutionHostId
} from '../../../../shared/execution-host'
import { getActiveSidebarWorkspaceId } from '../../../../shared/workspace-scope'
import { getPinnedWorktreeDisplayPolicy } from './worktree-list/grouping/row-types'
import { selectWorktreeListReviewCacheInputs } from './worktree-list/listing/review-cache-inputs'
import type { VirtualizedScrollAnchor } from '@/hooks/useVirtualizedScrollAnchor'
import { SidebarWorktreeListDialogs } from './worktree-list/rows/ProjectGroupDialogs'
import { SidebarWorktreeListEmptyState } from './worktree-list/listing/EmptyState'
import { VirtualizedWorktreeViewport } from './worktree-list/viewport/VirtualizedWorktreeViewport'
import { markSidebarWorktreeActiveImmediately } from './worktree-list/rows/option-dom'
import { EMPTY_PROJECT_GROUPS } from './worktree-list/viewport/viewport-props'
import { NOOP_WORKSPACE_BOARD_DRAG_PREVIEW_CALLBACK } from './worktree-list/drag/drop-commit-context'
import { useAgentSendTargetWorktreeId } from './worktree-list/listing/use-agent-send-target'
import { useEffectiveCollapsedGroups } from './worktree-list/listing/use-collapsed-groups'
import { useProjectGroupDialogs } from './worktree-list/rows/use-project-group-dialogs'
import { useSidebarExternalWorktreeCards } from './worktree-list/listing/use-external-worktree-cards'
import { useSidebarHostVisibleScope } from './worktree-list/listing/use-host-visible-scope'
import { useSidebarRevealRequests } from './worktree-list/navigation/use-reveal-requests'
import { useSidebarSectionRows } from './worktree-list/listing/use-section-rows'
import { useSidebarWorktreeFilters } from './worktree-list/listing/use-filters'
import { useSidebarWorktreeSelection } from './worktree-list/navigation/use-selection'
import { useSidebarWorktreeSortOrder } from './worktree-list/listing/use-sort-order'
import { useVisibleSidebarWorktrees } from './worktree-list/listing/use-visible-worktrees'
import { useWorktreeStatusMutations } from './worktree-list/drag/use-status-mutations'
import { shouldFiltersHideAllRows } from './sidebar-empty-state-gate'
import { buildWorktreeManualOrderCatalog } from './worktree-manual-order-catalog'

type WorktreeListProps = {
  scrollOffsetRef: React.MutableRefObject<number>
  scrollAnchorRef: React.MutableRefObject<VirtualizedScrollAnchor>
  workspaceBoardOpen?: boolean
  onWorkspaceBoardDragPreviewStart?: () => void
  onWorkspaceBoardDragPreviewCommit?: () => void
  onWorkspaceBoardDragPreviewCancel?: () => void
}

const WorktreeList = React.memo(function WorktreeList({
  scrollOffsetRef,
  scrollAnchorRef,
  workspaceBoardOpen = false,
  onWorkspaceBoardDragPreviewStart = NOOP_WORKSPACE_BOARD_DRAG_PREVIEW_CALLBACK,
  onWorkspaceBoardDragPreviewCommit = NOOP_WORKSPACE_BOARD_DRAG_PREVIEW_CALLBACK,
  onWorkspaceBoardDragPreviewCancel = NOOP_WORKSPACE_BOARD_DRAG_PREVIEW_CALLBACK
}: WorktreeListProps) {
  // ── Granular selectors (each is a primitive or shallow-stable ref) ──
  const allWorktrees = useAllWorktrees()
  const repoMap = useRepoMap()
  const worktreeMap = useWorktreeMap()
  const repos = useAppStore((s) => s.repos)
  const worktreeLineageById = useAppStore((s) => s.worktreeLineageById)
  const workspaceLineageByChildKey = useAppStore((s) => s.workspaceLineageByChildKey)
  const detectedWorktreesByRepo = useAppStore((s) => s.detectedWorktreesByRepo)
  const activeWorktreeId = useAppStore((s) => s.activeWorktreeId)
  const activeWorkspaceExecutionHostId = useAppStore((s) => s.activeWorkspaceExecutionHostId)
  const activeWorkspaceKey = useAppStore((s) => s.activeWorkspaceKey)
  const currentSidebarWorktreeId = useMemo(
    () => getActiveSidebarWorkspaceId(activeWorkspaceKey, activeWorktreeId),
    [activeWorkspaceKey, activeWorktreeId]
  )
  const groupBy = useAppStore((s) => s.groupBy)
  const workspaceStatuses = useAppStore((s) => s.workspaceStatuses)
  const sortBy = useAppStore((s) => s.sortBy)
  const projectOrderBy = useAppStore((s) => s.projectOrderBy)
  const openModal = useAppStore((s) => s.openModal)
  const openSettingsPage = useAppStore((s) => s.openSettingsPage)
  const openSettingsTarget = useAppStore((s) => s.openSettingsTarget)
  const activeView = useAppStore((s) => s.activeView)
  const activeModal = useAppStore((s) => s.activeModal)
  const pendingRevealWorktree = useAppStore((s) => s.pendingRevealWorktree)
  const pendingRevealSidebarRow = useAppStore((s) => s.pendingRevealSidebarRow)
  const clearPendingRevealWorktreeId = useAppStore((s) => s.clearPendingRevealWorktreeId)
  const clearPendingRevealSidebarRow = useAppStore((s) => s.clearPendingRevealSidebarRow)
  const collapsedGroups = useAppStore((s) => s.collapsedGroups)
  const toggleGroup = useAppStore((s) => s.toggleCollapsedGroup)
  const projectGroups = useAppStore((s) => s.projectGroups ?? EMPTY_PROJECT_GROUPS)
  const folderWorkspaces = useAppStore((s) => s.folderWorkspaces)
  const settings = useAppStore((s) => s.settings)
  const cardProps = useAppStore((s) => s.worktreeCardProperties)
  const { prCache, hostedReviewCache } = useAppStore(
    useShallow((s) => selectWorktreeListReviewCacheInputs(s, groupBy, cardProps))
  )
  const pinnedDisplayPolicy = getPinnedWorktreeDisplayPolicy(settings)
  const defaultHostId = getSettingsFocusedExecutionHostId(settings)
  const projectHostSetupProjection = useProjectHostSetupProjection()
  const projectGrouping = useMemo(
    () => ({
      projects: projectHostSetupProjection.projects,
      projectHostSetups: projectHostSetupProjection.setups
    }),
    [projectHostSetupProjection]
  )

  const agentSendTargetWorktreeId = useAgentSendTargetWorktreeId()
  const { filterState, hasFilters, clearFilters } = useSidebarWorktreeFilters()
  const sortedIds = useSidebarWorktreeSortOrder({ allWorktrees, repoMap, sortBy })
  const manualOrderCatalog = useMemo(
    () => buildWorktreeManualOrderCatalog({ worktrees: allWorktrees, folderWorkspaces }),
    [allWorktrees, folderWorkspaces]
  )
  const { visibleWorktrees, pairedDeviceIdsByEnvironment } = useVisibleSidebarWorktrees({
    filterState,
    sortBy,
    sortedIds,
    repoMap,
    worktreeLineageById,
    defaultHostId,
    agentSendTargetWorktreeId
  })
  const effectiveCollapsedGroups = useEffectiveCollapsedGroups({
    collapsedGroups,
    agentSendTargetWorktreeId,
    groupBy,
    pinnedDisplayPolicy,
    visibleWorktrees,
    repoMap,
    worktreeMap,
    worktreeLineageById,
    prCache,
    workspaceStatuses,
    settings,
    projectGroups,
    projectGrouping,
    folderWorkspaces,
    defaultHostId
  })
  const visibleScope = useSidebarHostVisibleScope({
    filterState,
    defaultHostId,
    repos,
    projectGroups,
    folderWorkspaces,
    pairedDeviceIdsByEnvironment
  })
  const externalWorktreeCards = useSidebarExternalWorktreeCards({
    repos,
    visibleReposForRows: visibleScope.visibleReposForRows,
    detectedWorktreesByRepo,
    filterRepoIds: filterState.filterRepoIds
  })
  const rowModel = useSidebarSectionRows({
    groupBy,
    projectOrderBy,
    pinnedDisplayPolicy,
    defaultHostId,
    worktrees: visibleWorktrees,
    repos,
    repoMap,
    worktreeMap,
    worktreeLineageById,
    prCache,
    settings,
    workspaceStatuses,
    effectiveCollapsedGroups,
    projectGrouping,
    visibleReposForRows: visibleScope.visibleReposForRows,
    visibleProjectGroupsForRows: visibleScope.visibleProjectGroupsForRows,
    visibleFolderWorkspacesForRows: visibleScope.visibleFolderWorkspacesForRows,
    importedWorktreesByRepo: externalWorktreeCards.importedWorktreesByRepo,
    newExternalWorktreesInboxByRepo: externalWorktreeCards.newExternalWorktreesInboxByRepo,
    filterRepoIds: filterState.filterRepoIds,
    visibleWorkspaceHostIds: filterState.visibleWorkspaceHostIds,
    workspaceHostScope: filterState.workspaceHostScope
  })
  const selection = useSidebarWorktreeSelection({
    sectionRows: rowModel.sectionRows,
    pinnedDisplayPolicy
  })
  const statusMutations = useWorktreeStatusMutations({
    manualOrderCatalog,
    worktreeMap,
    workspaceStatuses,
    sortBy
  })
  const projectGroupDialogs = useProjectGroupDialogs({ repos, repoMap, projectGroups })

  const handleImmediateWorktreeActivate = useCallback((worktreeId: string, rowKey?: string) => {
    // Why: re-rendering the virtualized sidebar on the pointer path adds visible latency; mutate the row directly and let store state reconcile after.
    markSidebarWorktreeActiveImmediately(worktreeId, rowKey)
  }, [])

  const handleCreateForRepo = useCallback(
    (projectId: string) => {
      openModal('new-workspace-composer', { initialRepoId: projectId, telemetrySource: 'sidebar' })
    },
    [openModal]
  )
  const handleOpenRepoSettings = useCallback(
    (projectId: string, sectionId?: string) => {
      openSettingsTarget({ pane: 'repo', repoId: projectId, ...(sectionId ? { sectionId } : {}) })
      openSettingsPage()
    },
    [openSettingsPage, openSettingsTarget]
  )
  const handleOpenWorktreeVisibility = useCallback(
    (repo: Repo) => {
      openModal('worktree-visibility', { repoId: repo.id, hostId: getRepoExecutionHostId(repo) })
    },
    [openModal]
  )
  const handleRemoveProject = useCallback(
    (repo: Repo) => {
      openModal('confirm-remove-folder', {
        repoId: repo.id,
        displayName: repo.displayName,
        hostId: getRepoExecutionHostId(repo)
      })
    },
    [openModal]
  )
  const handleCreateFolderWorkspace = useCallback(
    (projectGroup: ProjectGroup) => {
      if (!projectGroup.parentPath) {
        return
      }
      openModal('new-workspace-composer', {
        initialProjectGroupId: projectGroup.id,
        telemetrySource: 'sidebar'
      })
    },
    [openModal]
  )

  useSidebarRevealRequests({
    groupBy,
    renderedSidebarRowKeys: rowModel.renderedSidebarRowKeys,
    renderedWorktreeIdentities: selection.renderedWorktreeIdentities,
    currentSidebarWorktreeId,
    currentSidebarExecutionHostId: activeWorkspaceExecutionHostId,
    worktreeMap,
    worktrees: allWorktrees,
    folderWorkspaces,
    hasFilters,
    clearFilters
  })

  const filtersHideAllRows = shouldFiltersHideAllRows({
    hasFilters,
    visibleWorktreeCount: visibleWorktrees.length,
    visibleFolderWorkspaceCount: visibleScope.visibleFolderWorkspacesForRows.length,
    placeholderRepoCount: rowModel.placeholderRepoIds.size,
    importedWorktreeCardCount: externalWorktreeCards.importedWorktreesByRepo.size
  })
  // Why: when active filters hide every row, the Clear Filters empty state must win over Project Group headers.
  if (rowModel.rows.length === 0 || filtersHideAllRows) {
    return <SidebarWorktreeListEmptyState hasFilters={hasFilters} onClearFilters={clearFilters} />
  }

  return (
    <>
      <SidebarWorktreeListDialogs
        dialogs={projectGroupDialogs}
        repos={repos}
        settings={settings}
        suppressExternalWorktreeInboxRepoId={
          externalWorktreeCards.suppressExternalWorktreeInboxRepoId
        }
        setSuppressExternalWorktreeInboxRepoId={
          externalWorktreeCards.setSuppressExternalWorktreeInboxRepoId
        }
        newExternalWorktreeInboxActionState={
          externalWorktreeCards.newExternalWorktreeInboxActionState
        }
        onConfirmSuppressExternalWorktreeInbox={() => {
          void externalWorktreeCards.handleConfirmSuppressExternalWorktreeInbox()
        }}
        onOpenWorktreeVisibility={handleOpenWorktreeVisibility}
      />
      <VirtualizedWorktreeViewport
        // Why: status headers move during wake (inactive -> active); key only on grouping mode so row identity survives.
        key={`group:${groupBy}:host:${filterState.visibleWorkspaceHostIds?.join(',') ?? 'all'}:lineage`}
        rows={rowModel.sectionRows}
        // Why: full-page nav views aren't scoped to a worktree, so no sidebar card should look selected.
        activeWorktreeId={
          activeView === 'tasks' || activeView === 'activity' ? null : currentSidebarWorktreeId
        }
        activeWorkspaceExecutionHostId={activeWorkspaceExecutionHostId}
        currentWorktreeId={currentSidebarWorktreeId}
        groupBy={groupBy}
        pinnedDisplayPolicy={pinnedDisplayPolicy}
        projectOrderBy={projectOrderBy}
        toggleGroup={toggleGroup}
        collapsedGroups={effectiveCollapsedGroups}
        handleCreateForRepo={handleCreateForRepo}
        handleOpenRepoSettings={handleOpenRepoSettings}
        handleOpenWorktreeVisibility={handleOpenWorktreeVisibility}
        handleShowImportedWorktrees={externalWorktreeCards.handleShowImportedWorktrees}
        handleKeepImportedWorktreesHidden={externalWorktreeCards.handleKeepImportedWorktreesHidden}
        importedWorktreeCardActionState={externalWorktreeCards.importedWorktreeCardActionState}
        handleOpenSuppressExternalWorktreeInbox={
          externalWorktreeCards.handleOpenSuppressExternalWorktreeInbox
        }
        newExternalWorktreeInboxActionState={
          externalWorktreeCards.newExternalWorktreeInboxActionState
        }
        handleRemoveProject={handleRemoveProject}
        handleCreateGroupFromRepo={projectGroupDialogs.handleCreateGroupFromRepo}
        handleMoveProjectToGroup={projectGroupDialogs.handleMoveProjectToGroup}
        handleRemoveProjectFromGroup={projectGroupDialogs.handleRemoveProjectFromGroup}
        handleRenameProjectGroup={projectGroupDialogs.handleRenameProjectGroup}
        handleDeleteProjectGroup={projectGroupDialogs.handleDeleteProjectGroup}
        handleCreateFolderWorkspace={handleCreateFolderWorkspace}
        activeModal={activeModal}
        pendingRevealWorktree={pendingRevealWorktree}
        pendingRevealSidebarRow={pendingRevealSidebarRow}
        clearPendingRevealWorktreeId={clearPendingRevealWorktreeId}
        clearPendingRevealSidebarRow={clearPendingRevealSidebarRow}
        agentSendTargetWorktreeId={agentSendTargetWorktreeId}
        worktrees={visibleWorktrees}
        folderWorkspaces={folderWorkspaces}
        selectedWorktreeIds={selection.selectedWorktreeIds}
        selectedWorktrees={selection.selectedWorktrees}
        onSelectionGesture={selection.updateSelectionForGesture}
        onImmediateWorktreeActivate={handleImmediateWorktreeActivate}
        onContextMenuSelect={selection.selectForContextMenu}
        repoMap={repoMap}
        defaultHostId={defaultHostId}
        worktreeMap={worktreeMap}
        worktreeLineageById={worktreeLineageById}
        workspaceLineageByChildKey={workspaceLineageByChildKey}
        allRepoIds={rowModel.allRepoIds}
        onReorderHostSections={rowModel.handleReorderHostSections}
        onHostDragActiveChange={rowModel.setHostDragActive}
        prCache={prCache}
        hostedReviewCache={hostedReviewCache}
        workspaceStatuses={workspaceStatuses}
        projectGrouping={projectGrouping}
        projectGroups={projectGroups}
        onMoveWorktreeToStatus={statusMutations.moveWorktreeToStatus}
        onMoveWorktreesToStatus={statusMutations.moveWorktreesToStatus}
        onMoveWorktreesToStatusAtIndex={statusMutations.moveWorktreesToStatusAtIndex}
        onPinWorktree={statusMutations.pinWorktree}
        onPinWorktrees={statusMutations.pinWorktrees}
        onDropWorktreesOnWorkspaceBoard={statusMutations.dropWorktreesOnWorkspaceBoard}
        workspaceBoardOpen={workspaceBoardOpen}
        onWorkspaceBoardDragPreviewStart={onWorkspaceBoardDragPreviewStart}
        onWorkspaceBoardDragPreviewCommit={onWorkspaceBoardDragPreviewCommit}
        onWorkspaceBoardDragPreviewCancel={onWorkspaceBoardDragPreviewCancel}
        shouldShowWorkspaceBoardDropIndicator={
          statusMutations.shouldShowWorkspaceBoardDropIndicator
        }
        onReorderWorktrees={statusMutations.reorderWorktrees}
        scrollOffsetRef={scrollOffsetRef}
        scrollAnchorRef={scrollAnchorRef}
      />
    </>
  )
})

export default WorktreeList
