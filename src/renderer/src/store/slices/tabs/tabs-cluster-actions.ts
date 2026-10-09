import { TAB_CLUSTER_COLORS, type TabCluster } from '../../../../../shared/tab-types'
import type { TabsSlice, TabsSliceGet, TabsSliceSet } from './tabs-slice-contract'
import { findGroupAndWorktree, updateGroup } from '../tab-group-state'
import { createTabClusterId, isTabClusterColor } from './tab-cluster-model'
import { normalizeTabStripSelection } from './tab-cluster-invariant'
import {
  buildTabClusterStripMove,
  createTabsClusterStripActions,
  promoteClusterPreviewTabs
} from './tabs-cluster-strip-actions'
import { moveTabsToPane } from './tabs-drop-actions'

export function createTabsClusterActions(
  set: TabsSliceSet,
  get: TabsSliceGet
): Pick<
  TabsSlice,
  | 'setTabSelection'
  | 'setRenamingTabCluster'
  | 'createTabCluster'
  | 'addTabsToCluster'
  | 'removeTabsFromCluster'
  | 'renameTabCluster'
  | 'setTabClusterColor'
  | 'setTabClusterCollapsed'
  | 'ungroupTabCluster'
  | 'moveTabsInStrip'
  | 'moveTabCluster'
> {
  const patchCluster = (
    groupId: string,
    clusterId: string,
    patch: Partial<Pick<TabCluster, 'name' | 'color' | 'collapsed'>>
  ): void => {
    set((state) => {
      const found = findGroupAndWorktree(state.groupsByWorktree, groupId)
      const cluster = found?.group.tabClusters?.find((candidate) => candidate.id === clusterId)
      if (!found || !cluster) {
        return state
      }
      if (
        (patch.name === undefined || patch.name === cluster.name) &&
        (patch.color === undefined || patch.color === cluster.color) &&
        (patch.collapsed === undefined || patch.collapsed === cluster.collapsed)
      ) {
        return state
      }
      const nextCluster = { ...cluster, ...patch }
      if (patch.collapsed !== undefined) {
        delete nextCluster.shownTabId
        const shownTabId = found.group.activeTabId
        if (patch.collapsed && shownTabId && cluster.tabIds.includes(shownTabId)) {
          nextCluster.shownTabId = shownTabId
        }
      }
      return {
        groupsByWorktree: {
          ...state.groupsByWorktree,
          [found.worktreeId]: updateGroup(state.groupsByWorktree[found.worktreeId], {
            ...found.group,
            tabClusters: found.group.tabClusters?.map((candidate) =>
              candidate.id === clusterId ? nextCluster : candidate
            )
          })
        }
      }
    })
  }

  return {
    setTabSelection: (groupId, selection) => {
      set((state) => {
        const found = findGroupAndWorktree(state.groupsByWorktree, groupId)
        const liveIds = new Set(
          (state.unifiedTabsByWorktree[found?.worktreeId ?? ''] ?? [])
            .filter((tab) => tab.groupId === groupId)
            .map((tab) => tab.id)
        )
        const previous = state.tabSelectionByGroupId[groupId]
        const normalized = normalizeTabStripSelection(selection, found?.group, liveIds, previous)
        if (normalized === previous) {
          return state
        }
        const tabSelectionByGroupId = { ...state.tabSelectionByGroupId }
        if (normalized) {
          tabSelectionByGroupId[groupId] = normalized
        } else {
          delete tabSelectionByGroupId[groupId]
        }
        return { tabSelectionByGroupId }
      })
    },
    setRenamingTabCluster: (request) => set({ renamingTabCluster: request }),

    createTabCluster: (groupId, tabIds, init) => {
      promoteClusterPreviewTabs(get, groupId, tabIds)
      let createdId: string | null = null
      set((state) => {
        const found = findGroupAndWorktree(state.groupsByWorktree, groupId)
        if (!found) {
          return state
        }
        const tabs = state.unifiedTabsByWorktree[found.worktreeId] ?? []
        const eligible = new Set(
          tabs.filter((tab) => tab.groupId === groupId && !tab.isPinned).map((tab) => tab.id)
        )
        const requested = new Set(tabIds)
        const members = found.group.tabOrder.filter((id) => requested.has(id) && eligible.has(id))
        if (!members.length) {
          return state
        }
        const existing = found.group.tabClusters ?? []
        const memberIds = new Set(members)
        const remainingOrder = found.group.tabOrder.filter((id) => !memberIds.has(id))
        const sourceCluster = existing.find((cluster) => cluster.tabIds.includes(members[0]))
        const lastRemainingMember = sourceCluster?.tabIds.findLast((id) => !memberIds.has(id))
        let index = found.group.tabOrder.indexOf(members[0])
        if (sourceCluster && sourceCluster.tabIds[0] !== members[0] && lastRemainingMember) {
          const sourceEnd = remainingOrder.indexOf(lastRemainingMember)
          if (index <= sourceEnd) {
            index = sourceEnd + 1
          }
        }
        const usedColors = new Set(existing.map((cluster) => cluster.color))
        const color =
          init?.color && isTabClusterColor(init.color)
            ? init.color
            : (TAB_CLUSTER_COLORS.find((candidate) => !usedColors.has(candidate)) ??
              TAB_CLUSTER_COLORS[existing.length % TAB_CLUSTER_COLORS.length])
        const id = createTabClusterId()
        const cluster: TabCluster = {
          id,
          name: (init?.name ?? '').trim().slice(0, 80),
          color,
          collapsed: false,
          tabIds: []
        }
        const next = buildTabClusterStripMove(
          { ...found.group, tabClusters: [...existing, cluster] },
          tabs,
          members,
          { index, clusterId: id }
        )
        if (!next) {
          return state
        }
        createdId = id
        const tabSelectionByGroupId = { ...state.tabSelectionByGroupId }
        delete tabSelectionByGroupId[groupId]
        return {
          groupsByWorktree: {
            ...state.groupsByWorktree,
            [found.worktreeId]: updateGroup(state.groupsByWorktree[found.worktreeId], next.group)
          },
          unifiedTabsByWorktree: { ...state.unifiedTabsByWorktree, [found.worktreeId]: next.tabs },
          tabSelectionByGroupId
        }
      })
      return createdId
    },

    renameTabCluster: (groupId, clusterId, name) =>
      patchCluster(groupId, clusterId, { name: name.trim().slice(0, 80) }),
    setTabClusterColor: (groupId, clusterId, color) => {
      if (isTabClusterColor(color)) {
        patchCluster(groupId, clusterId, { color })
      }
    },
    setTabClusterCollapsed: (groupId, clusterId, collapsed) =>
      patchCluster(groupId, clusterId, { collapsed }),

    ungroupTabCluster: (groupId, clusterId) => {
      set((state) => {
        const found = findGroupAndWorktree(state.groupsByWorktree, groupId)
        if (!found?.group.tabClusters?.some((cluster) => cluster.id === clusterId)) {
          return state
        }
        const clusters = found.group.tabClusters.filter((cluster) => cluster.id !== clusterId)
        const group = { ...found.group }
        delete group.tabClusters
        if (clusters.length) {
          group.tabClusters = clusters
        }
        return {
          groupsByWorktree: {
            ...state.groupsByWorktree,
            [found.worktreeId]: updateGroup(state.groupsByWorktree[found.worktreeId], group)
          }
        }
      })
    },
    ...createTabsClusterStripActions(set, get),
    moveTabCluster: (sourceGroupId, clusterId, target) => {
      const source = findGroupAndWorktree(get().groupsByWorktree, sourceGroupId)
      const cluster = source?.group.tabClusters?.find((candidate) => candidate.id === clusterId)
      return source && cluster
        ? moveTabsToPane(
            set,
            get,
            source.worktreeId,
            sourceGroupId,
            cluster.tabIds,
            target,
            cluster
          )
        : false
    }
  }
}
