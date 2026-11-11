import { useCallback, useMemo, useState, useSyncExternalStore } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store/index'
import { useDesktopSidebarFeed } from '@/components/sidebar/sidebar-feed/desktop-sidebar-feed'
import {
  overlaySidebarPendingLayer,
  readSidebarPendingLayer,
  subscribeSidebarPendingLayer
} from '@/components/sidebar/sidebar-feed/sidebar-pending-layer'
import { useSidebarListSession } from '@/components/sidebar/sidebar-feed/sidebar-list-session'
import {
  readEndedCreations,
  subscribeEndedCreations
} from '@/components/sidebar/sidebar-feed/sidebar-ended-creations'
import {
  readHiddenVmCheckouts,
  subscribeHiddenVmCheckouts,
  withoutHiddenVmCheckouts
} from '@/runtime/ephemeral-vm/vm-create-hidden-checkouts'
import '../../../../../../shared/folder-workspaces/folder-workspace-execution-host'
import { getFolderWorkspaceHostId } from '../../../../../../shared/folder-workspaces/folder-workspace-host-id'
import type { FolderWorkspace } from '../../../../../../shared/folder-workspaces/folder-workspace-types'
import {
  getLocalExecutionHostLabel,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../../../../shared/execution-host'
import { getHostDisplayLabelOverrides } from '../../../../../../shared/host-setting-overrides'
import { EMPTY_SIDEBAR_FEED_DOMAINS } from '../../../../../../shared/sidebar-feed-client/sidebar-feed-snapshot'
import {
  planSidebarFeedRows,
  renderSidebarFeedRows,
  type SidebarFeedView
} from '../../../../../../shared/sidebar-list/sidebar-feed-rows'
import {
  indexSidebarFeed,
  rankSidebarFeedWorktrees
} from '../../../../../../shared/sidebar-list/sidebar-feed-index'
import {
  filterReposForVisibleHosts,
  getVisibleSidebarHostIdSet
} from '../../../../../../shared/sidebar-list/host-filtering'
import { mergeDraggedHostSectionOrder } from '../../../../../../shared/sidebar-list/host-section-order'
import type { HostSectionRow } from '../../../../../../shared/sidebar-list/host-section-rows'
import type { Worktree } from '../../../../../../shared/worktree/types'
import { getWorktreeHostIdentity } from '../../../../../../shared/worktree/host-qualified-identity'
import { sidebarWorkspaceRowFilters } from '../controls/sidebar-filter-actions'
import type { SidebarListModel, SidebarListModelArgs } from './sidebar-list-model'
import { withWindowCreations } from './window-worktree-creations'
export { withWindowCreations } from './window-worktree-creations'
import { selectPendingWorktreeCreationKeys } from './pending-worktree-creation-keys'
import { collectRenderedSidebarRowKeys } from './rendered-row-keys'
import { useEffectiveCollapsedGroups } from './use-collapsed-groups'
import { useSidebarExternalWorktreeCards } from './use-external-worktree-cards'
import { useOrderHeldWhileEngaged, useProjectRecencyHeldWhileEngaged } from './use-order-hold'
import { useReusedArrayIdentity } from './use-reused-array-identity'

// The window renders its own collapse, so planning never re-runs on a toggle.
const PLANNED_UNCOLLAPSED: ReadonlySet<string> = new Set()

function folderRecordKey(id: string, hostId: string | null | undefined): string {
  return `${parseExecutionHostId(hostId)?.id ?? ''}\0${id}`
}

// Main's rows answer for the list; the window's own records answer for what a card shows.
function windowRecordOf(records: ReadonlyMap<string, Worktree>, worktree: Worktree): Worktree {
  return records.get(getWorktreeHostIdentity(worktree)) ?? worktree
}

function windowFolderRecordOf(
  records: ReadonlyMap<string, FolderWorkspace>,
  folder: FolderWorkspace
): FolderWorkspace {
  return records.get(folderRecordKey(folder.id, folder.executionHostId)) ?? folder
}

/** Use the phone’s builder over main’s domains, adding desktop state and pending writes; cards read window records. */
export function useMainSidebarListModel(args: SidebarListModelArgs): SidebarListModel {
  const { filterState, sortBy, groupBy, repos, defaultHostId, settings } = args
  useSidebarListSession()
  const feed = useDesktopSidebarFeed()
  const pending = useSyncExternalStore(subscribeSidebarPendingLayer, readSidebarPendingLayer)
  const endedCreationIds = useSyncExternalStore(subscribeEndedCreations, readEndedCreations)
  const hiddenVmCheckouts = useSyncExternalStore(subscribeHiddenVmCheckouts, readHiddenVmCheckouts)
  const pendingCreationKeys = useAppStore(
    useShallow((s) => selectPendingWorktreeCreationKeys(s.pendingWorktreeCreations))
  )
  const hiddenCreationKeys = useAppStore(
    useShallow((s) => selectPendingWorktreeCreationKeys(s.pendingWorktreeCreations, 'hidden'))
  )
  const workspaceHostOrder = useAppStore((s) => s.workspaceHostOrder)
  const showHostSections = useAppStore((s) => s.showWorkspaceHostSections)
  const setWorkspaceHostOrder = useAppStore((s) => s.setWorkspaceHostOrder)
  const domains = useMemo(
    () =>
      withWindowCreations(
        withoutHiddenVmCheckouts(
          overlaySidebarPendingLayer(feed?.domains ?? EMPTY_SIDEBAR_FEED_DOMAINS, pending, {
            repos,
            lineageById: args.worktreeLineageById
          }),
          hiddenVmCheckouts
        ),
        pendingCreationKeys,
        endedCreationIds,
        hiddenCreationKeys
      ),
    [
      feed,
      pending,
      pendingCreationKeys,
      endedCreationIds,
      hiddenCreationKeys,
      hiddenVmCheckouts,
      repos,
      args.worktreeLineageById
    ]
  )
  const catalog = useMemo(
    () => ({ repos, projectGroups: args.projectGroups, projectGrouping: args.projectGrouping }),
    [repos, args.projectGroups, args.projectGrouping]
  )
  const view: SidebarFeedView = useMemo(
    () => ({
      groupBy,
      sortBy,
      projectOrderBy: args.projectOrderBy,
      collapsedGroups: PLANNED_UNCOLLAPSED,
      filters: sidebarWorkspaceRowFilters(filterState),
      workspaceHostScope: filterState.workspaceHostScope,
      visibleWorkspaceHostIds: filterState.visibleWorkspaceHostIds,
      showHostSections,
      workspaceStatuses: args.workspaceStatuses,
      pinnedDisplayPolicy: args.pinnedDisplayPolicy,
      defaultHostId,
      hostLabelOverrides: getHostDisplayLabelOverrides(settings),
      localHostLabel: getLocalExecutionHostLabel(),
      workspaceHostOrder
    }),
    [
      groupBy,
      sortBy,
      args.projectOrderBy,
      filterState,
      args.workspaceStatuses,
      args.pinnedDisplayPolicy,
      defaultHostId,
      settings,
      showHostSections,
      workspaceHostOrder
    ]
  )
  const liveIndex = useMemo(() => indexSidebarFeed(domains, repos), [domains, repos])
  const ranked = useMemo(() => rankSidebarFeedWorktrees(liveIndex, sortBy), [liveIndex, sortBy])
  const rankedIds = useOrderHeldWhileEngaged(useReusedArrayIdentity(ranked), sortBy)
  const index = useProjectRecencyHeldWhileEngaged(liveIndex, args.projectOrderBy)

  const visibleReposForRows = useMemo(
    () =>
      filterReposForVisibleHosts(
        repos,
        getVisibleSidebarHostIdSet(
          filterState.visibleWorkspaceHostIds,
          filterState.workspaceHostScope
        ),
        defaultHostId
      ),
    [repos, filterState.visibleWorkspaceHostIds, filterState.workspaceHostScope, defaultHostId]
  )
  const externalWorktreeCards = useSidebarExternalWorktreeCards({
    repos,
    visibleReposForRows,
    detectedWorktreesByRepo: args.detectedWorktreesByRepo,
    filterRepoIds: filterState.filterRepoIds
  })
  const { importedWorktreesByRepo, newExternalWorktreesInboxByRepo } = externalWorktreeCards
  const planned = useMemo(
    () =>
      planSidebarFeedRows(domains, index, catalog, view, rankedIds, {
        forcedVisibleWorktreeIds: args.agentSendTargetWorktreeId
          ? [args.agentSendTargetWorktreeId]
          : undefined,
        importedWorktreesByRepo,
        newExternalWorktreesInboxByRepo
      }),
    [
      domains,
      index,
      catalog,
      view,
      rankedIds,
      args.agentSendTargetWorktreeId,
      importedWorktreesByRepo,
      newExternalWorktreesInboxByRepo
    ]
  )

  const worktreeByIdentity = useMemo(
    () =>
      new Map(args.allWorktrees.map((worktree) => [getWorktreeHostIdentity(worktree), worktree])),
    [args.allWorktrees]
  )
  const folderByKey = useMemo(
    () =>
      new Map(
        args.folderWorkspaces.map((folder) => [
          folderRecordKey(folder.id, getFolderWorkspaceHostId(folder, args.projectGroups)),
          folder
        ])
      ),
    [args.folderWorkspaces, args.projectGroups]
  )
  const visibleWorktrees = useReusedArrayIdentity(
    useMemo(
      () =>
        planned.visibleWorktrees.map((worktree) => windowRecordOf(worktreeByIdentity, worktree)),
      [planned.visibleWorktrees, worktreeByIdentity]
    )
  )
  const visibleFolderWorkspacesForRows = useReusedArrayIdentity(
    useMemo(
      () =>
        planned.visibleFolderWorkspaces.map((folder) => windowFolderRecordOf(folderByKey, folder)),
      [planned.visibleFolderWorkspaces, folderByKey]
    )
  )

  const effectiveCollapsedGroups = useEffectiveCollapsedGroups({
    occurrencePlan: planned.plan.occurrencePlan,
    hostScopedGroups: planned.hostScoped,
    collapsedGroups: args.collapsedGroups,
    agentSendTargetWorktreeId: args.agentSendTargetWorktreeId,
    groupBy,
    pinnedDisplayPolicy: args.pinnedDisplayPolicy,
    worktrees: planned.visibleWorktrees,
    visibleWorktrees: planned.visibleWorktrees,
    filterRepoIds: filterState.filterRepoIds,
    repoMap: index.repoMap,
    worktreeMap: planned.worktreeMap,
    worktreeLineageById: planned.lineageById,
    prCache: args.prCache,
    workspaceStatuses: args.workspaceStatuses,
    projectGroups: planned.visibleProjectGroups,
    projectGrouping: args.projectGrouping,
    folderWorkspaces: planned.visibleFolderWorkspaces,
    defaultHostId
  })
  const [hostDragActive, setHostDragActive] = useState(false)
  const rendered = useMemo(
    () => renderSidebarFeedRows(planned, view, effectiveCollapsedGroups, hostDragActive),
    [planned, view, effectiveCollapsedGroups, hostDragActive]
  )
  const sectionRows = useMemo(
    () =>
      rendered.sectionRows.map((row): HostSectionRow => {
        if (row.type === 'item') {
          const worktree = windowRecordOf(worktreeByIdentity, row.worktree)
          return worktree === row.worktree ? row : { ...row, worktree }
        }
        if (row.type === 'folder-workspace') {
          const folderWorkspace = windowFolderRecordOf(folderByKey, row.folderWorkspace)
          return folderWorkspace === row.folderWorkspace ? row : { ...row, folderWorkspace }
        }
        return row
      }),
    [rendered.sectionRows, worktreeByIdentity, folderByKey]
  )
  const renderedSidebarRowKeys = useMemo(
    () => collectRenderedSidebarRowKeys(sectionRows),
    [sectionRows]
  )
  const allRepoIds = useMemo(() => repos.map((repo) => repo.id), [repos])
  const { orderedHostOptions } = planned
  const handleReorderHostSections = useCallback(
    (orderedVisibleHostIds: ExecutionHostId[]) =>
      setWorkspaceHostOrder(
        mergeDraggedHostSectionOrder(
          orderedVisibleHostIds,
          workspaceHostOrder,
          orderedHostOptions.map((host) => host.id)
        )
      ),
    [orderedHostOptions, setWorkspaceHostOrder, workspaceHostOrder]
  )

  return {
    visibleWorktrees,
    visibleScope: {
      visibleReposForRows,
      visibleProjectGroupsForRows: planned.visibleProjectGroups,
      visibleFolderWorkspacesForRows
    },
    externalWorktreeCards,
    rowModel: {
      occurrencePlan: planned.plan.occurrencePlan,
      hostOptions: planned.orderedHostOptions,
      effectiveCollapsedGroups,
      rows: rendered.rows,
      sectionRows,
      renderedSidebarRowKeys,
      allRepoIds,
      placeholderRepoIds: planned.placeholderRepoIds,
      handleReorderHostSections,
      setHostDragActive
    }
  }
}
