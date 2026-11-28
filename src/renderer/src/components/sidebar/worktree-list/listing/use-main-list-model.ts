import { useCallback, useMemo, useState, useSyncExternalStore } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store/index'
import { useBotListedWorktreeIdentities } from '@/components/bots/use-bot-listed-worktree-identities'
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
import {
  getLocalExecutionHostLabel,
  type ExecutionHostId
} from '../../../../../../shared/execution-host/execution-host'
import { getHostDisplayLabelOverrides } from '../../../../../../shared/execution-host/host-setting-overrides'
import { EMPTY_SIDEBAR_FEED_DOMAINS } from '../../../../../../shared/sidebar-feed-client/sidebar-feed-snapshot'
import {
  planSidebarFeedRows,
  renderSidebarFeedRows,
  type SidebarFeedView
} from '../../../../../../shared/sidebar-list/feed/sidebar-feed-rows'
import {
  indexSidebarFeed,
  rankSidebarFeedWorktrees
} from '../../../../../../shared/sidebar-list/feed/sidebar-feed-index'
import {
  filterReposForVisibleHosts,
  getVisibleSidebarHostIdSet
} from '../../../../../../shared/sidebar-list/hosts/host-filtering'
import { mergeDraggedHostSectionOrder } from '../../../../../../shared/sidebar-list/hosts/host-section-order'
import { sidebarWorkspaceRowFilters } from '../controls/sidebar-filter-actions'
import type { SidebarListModel, SidebarListModelArgs } from './sidebar-list-model'
import { withWindowCreations } from './window-worktree-creations'
export { withWindowCreations } from './window-worktree-creations'
import { selectPendingWorktreeCreationKeys } from './pending-worktree-creation-keys'
import { useEffectiveCollapsedGroups } from './use-collapsed-groups'
import { useSidebarExternalWorktreeCards } from './use-external-worktree-cards'
import { useOrderHeldWhileEngaged, useProjectRecencyHeldWhileEngaged } from './use-order-hold'
import { useReusedArrayIdentity } from './use-reused-array-identity'
import {
  indexFoldersByKey,
  indexWorktreesByIdentity,
  overlayWindowSectionRows,
  windowFolderRecordOf,
  windowRecordOf
} from './window-record-overlay'

const getAppStoreState = (): ReturnType<typeof useAppStore.getState> => useAppStore.getState()
// The window renders its own collapse, so planning never re-runs on a toggle.
const PLANNED_UNCOLLAPSED: ReadonlySet<string> = new Set()

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
  const { setWorkspaceHostOrder } = getAppStoreState()
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
  // The window-model list leaves these out too (compute-visible-worktrees.ts).
  const botListedWorktreeIdentities = useBotListedWorktreeIdentities()
  const planned = useMemo(
    () =>
      planSidebarFeedRows(domains, index, catalog, view, rankedIds, {
        forcedVisibleWorktreeIds: args.agentSendTargetWorktreeId
          ? [args.agentSendTargetWorktreeId]
          : undefined,
        botListedWorktreeIdentities,
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
      botListedWorktreeIdentities,
      importedWorktreesByRepo,
      newExternalWorktreesInboxByRepo
    ]
  )

  const worktreeByIdentity = useMemo(
    () => indexWorktreesByIdentity(args.allWorktrees),
    [args.allWorktrees]
  )
  const folderByKey = useMemo(
    () => indexFoldersByKey(args.folderWorkspaces, args.projectGroups),
    [args.folderWorkspaces, args.projectGroups]
  )
  const visibleWorktrees = useReusedArrayIdentity(
    useMemo(
      () =>
        planned.visibleWorktrees.length === 0 || worktreeByIdentity.size === 0
          ? [...planned.visibleWorktrees]
          : planned.visibleWorktrees.map((worktree) =>
              windowRecordOf(worktreeByIdentity, worktree)
            ),
      [planned.visibleWorktrees, worktreeByIdentity]
    )
  )
  const visibleFolderWorkspacesForRows = useReusedArrayIdentity(
    useMemo(
      () =>
        planned.visibleFolderWorkspaces.length === 0 || folderByKey.size === 0
          ? [...planned.visibleFolderWorkspaces]
          : planned.visibleFolderWorkspaces.map((folder) =>
              windowFolderRecordOf(folderByKey, folder)
            ),
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
    () => overlayWindowSectionRows(rendered.sectionRows, worktreeByIdentity, folderByKey),
    [rendered.sectionRows, worktreeByIdentity, folderByKey]
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
      allRepoIds,
      placeholderRepoIds: planned.placeholderRepoIds,
      handleReorderHostSections,
      setHostDragActive
    }
  }
}
