import type { Tab, TabGroup } from '../../../../../shared/tab-types'
import type { TabsSlice, TabsSliceGet, TabsSliceSet } from './tabs-slice-contract'
import { findGroupAndWorktree, updateGroup } from '../tab-group-state'
import { normalizeTabClusters } from './tab-cluster-model'
import { applyTabOrderSortValues } from './tabs-tab-order'

export function buildTabClusterStripMove(
  group: TabGroup,
  tabs: Tab[],
  tabIds: readonly string[],
  target: { index: number; clusterId: string | null }
): { group: TabGroup; tabs: Tab[] } | null {
  if (target.clusterId && !group.tabClusters?.some((cluster) => cluster.id === target.clusterId)) {
    return null
  }
  const requested = new Set(tabIds)
  const tabById = new Map(
    tabs.filter((tab) => tab.groupId === group.id).map((tab) => [tab.id, tab])
  )
  const moved = group.tabOrder.filter((id) => {
    const tab = tabById.get(id)
    return requested.has(id) && tab && (!target.clusterId || !tab.isPinned)
  })
  if (!moved.length) {
    return null
  }
  const movedIds = new Set(moved)
  const tabOrder = group.tabOrder.filter((id) => !movedIds.has(id))
  tabOrder.splice(Math.max(0, Math.min(target.index, tabOrder.length)), 0, ...moved)
  const clusters = group.tabClusters?.map((cluster) => ({
    ...cluster,
    tabIds: [
      ...cluster.tabIds.filter((id) => !movedIds.has(id)),
      ...(cluster.id === target.clusterId ? moved : [])
    ]
  }))
  const tabClusters = normalizeTabClusters({
    tabOrder,
    clusters,
    // Why: explicit ungrouping must leave a gap instead of sandwich-rejoining the moved tabs.
    pinnedTabIds: new Set([
      ...tabs.filter((tab) => tab.isPinned).map((tab) => tab.id),
      ...(target.clusterId === null ? moved : [])
    ])
  })
  const nextGroup = { ...group, tabOrder }
  delete nextGroup.tabClusters
  if (tabClusters) {
    nextGroup.tabClusters = tabClusters
  }
  const nextTabs = target.clusterId
    ? tabs.map((tab) =>
        movedIds.has(tab.id) && tab.isPreview ? { ...tab, isPreview: false } : tab
      )
    : tabs
  return { group: nextGroup, tabs: applyTabOrderSortValues(nextTabs, tabOrder) }
}

export function promoteClusterPreviewTabs(
  get: TabsSliceGet,
  groupId: string,
  tabIds: string[]
): void {
  const state = get()
  const found = findGroupAndWorktree(state.groupsByWorktree, groupId)
  if (!found) {
    return
  }
  const requested = new Set(tabIds)
  for (const tab of state.unifiedTabsByWorktree[found.worktreeId] ?? []) {
    if (tab.groupId !== groupId || !requested.has(tab.id) || tab.isPinned || !tab.isPreview) {
      continue
    }
    if (tab.contentType === 'editor') {
      state.makePreviewFilePermanent(tab.entityId, tab.id)
    }
  }
}

export function createTabsClusterStripActions(
  set: TabsSliceSet,
  get: TabsSliceGet
): Pick<TabsSlice, 'addTabsToCluster' | 'removeTabsFromCluster' | 'moveTabsInStrip'> {
  return {
    addTabsToCluster: (groupId, clusterId, tabIds) => {
      const found = findGroupAndWorktree(get().groupsByWorktree, groupId)
      if (!found?.group.tabClusters?.some((cluster) => cluster.id === clusterId)) {
        return false
      }
      promoteClusterPreviewTabs(get, groupId, tabIds)
      let moved = false
      set((state) => {
        const current = findGroupAndWorktree(state.groupsByWorktree, groupId)
        const cluster = current?.group.tabClusters?.find((candidate) => candidate.id === clusterId)
        if (!current || !cluster) {
          return state
        }
        const tabs = state.unifiedTabsByWorktree[current.worktreeId] ?? []
        const eligible = new Set(tabs.filter((tab) => !tab.isPinned).map((tab) => tab.id))
        const requested = new Set(tabIds.filter((id) => eligible.has(id)))
        const remaining = current.group.tabOrder.filter((id) => !requested.has(id))
        const remainingMembers = cluster.tabIds.filter((id) => !requested.has(id))
        const index = remainingMembers.length
          ? remaining.indexOf(remainingMembers.at(-1)!) + 1
          : current.group.tabOrder
              .slice(0, current.group.tabOrder.indexOf(cluster.tabIds[0]))
              .filter((id) => !requested.has(id)).length
        const next = buildTabClusterStripMove(current.group, tabs, tabIds, { index, clusterId })
        if (!next) {
          return state
        }
        moved = true
        return {
          groupsByWorktree: {
            ...state.groupsByWorktree,
            [current.worktreeId]: updateGroup(
              state.groupsByWorktree[current.worktreeId],
              next.group
            )
          },
          unifiedTabsByWorktree: { ...state.unifiedTabsByWorktree, [current.worktreeId]: next.tabs }
        }
      })
      return moved
    },

    removeTabsFromCluster: (groupId, tabIds) => {
      set((state) => {
        const found = findGroupAndWorktree(state.groupsByWorktree, groupId)
        if (!found?.group.tabClusters?.length) {
          return state
        }
        const requested = new Set(tabIds)
        const tabs = state.unifiedTabsByWorktree[found.worktreeId] ?? []
        let group = found.group
        let nextTabs = tabs
        for (const cluster of found.group.tabClusters) {
          const removed = cluster.tabIds.filter((id) => requested.has(id))
          if (!removed.length) {
            continue
          }
          const removedIds = new Set(removed)
          const lastMemberIndex = Math.max(
            ...cluster.tabIds.map((id) => group.tabOrder.indexOf(id))
          )
          const index = group.tabOrder
            .slice(0, lastMemberIndex + 1)
            .filter((id) => !removedIds.has(id)).length
          const next = buildTabClusterStripMove(group, nextTabs, removed, {
            index,
            clusterId: null
          })
          if (next) {
            group = next.group
            nextTabs = next.tabs
          }
        }
        if (group === found.group) {
          return state
        }
        return {
          groupsByWorktree: {
            ...state.groupsByWorktree,
            [found.worktreeId]: updateGroup(state.groupsByWorktree[found.worktreeId], group)
          },
          unifiedTabsByWorktree: { ...state.unifiedTabsByWorktree, [found.worktreeId]: nextTabs }
        }
      })
    },

    moveTabsInStrip: (groupId, tabIds, target) => {
      if (target.clusterId) {
        const found = findGroupAndWorktree(get().groupsByWorktree, groupId)
        if (!found?.group.tabClusters?.some((cluster) => cluster.id === target.clusterId)) {
          return
        }
        promoteClusterPreviewTabs(get, groupId, tabIds)
      }
      set((state) => {
        const found = findGroupAndWorktree(state.groupsByWorktree, groupId)
        if (!found) {
          return state
        }
        const next = buildTabClusterStripMove(
          found.group,
          state.unifiedTabsByWorktree[found.worktreeId] ?? [],
          tabIds,
          target
        )
        if (!next) {
          return state
        }
        return {
          groupsByWorktree: {
            ...state.groupsByWorktree,
            [found.worktreeId]: updateGroup(state.groupsByWorktree[found.worktreeId], next.group)
          },
          unifiedTabsByWorktree: { ...state.unifiedTabsByWorktree, [found.worktreeId]: next.tabs }
        }
      })
    }
  }
}
