import { createBrowserUuid } from '@/lib/browser-uuid'
import type { TabCluster, TabGroup } from '../../../../../shared/tab-types'
import type { TabsSlice, TabsSliceGet, TabsSliceSet } from './tabs-slice-contract'
import { isPaneColumnSplitDropNoOp } from '../pane-column-split-drop-no-op'
import { collapseGroupLayout, buildSplitNode, replaceLeaf } from './tabs-layout'
import { buildActiveSurfacePatch } from './tabs-surface'
import { applyTransferredTabClusterMembership } from './tab-cluster-transfer'
import { promoteClusterPreviewTabs } from './tabs-cluster-strip-actions'
import { mergeTabClusterRecords, normalizeTabGroupClusters } from './tab-cluster-model'
import { applyTabOrderSortValues } from './tabs-tab-order'
import {
  dedupeTabOrder,
  findGroupAndWorktree,
  findGroupForTab,
  findTabAndWorktree,
  pickNextActiveTab,
  pushRecentTabId,
  sanitizeRecentTabIds
} from '../tab-group-state'

export function moveTabsToPane(
  set: TabsSliceSet,
  get: TabsSliceGet,
  worktreeId: string,
  sourceGroupId: string,
  tabIds: readonly string[],
  target: Parameters<TabsSlice['dropUnifiedTab']>[1],
  carriedCluster?: TabCluster
): boolean {
  let moved = false
  const memberIds = new Set(tabIds)
  set((state) => {
    const sourceGroup = findGroupForTab(state.groupsByWorktree, worktreeId, sourceGroupId)
    const destination = findGroupAndWorktree(state.groupsByWorktree, target.groupId)
    if (!sourceGroup || !destination || worktreeId !== destination.worktreeId || !tabIds.length) {
      return state
    }
    const targetGroup = destination.group
    const isSplitDrop = Boolean(target.splitDirection)
    if (!isSplitDrop && sourceGroupId === target.groupId) {
      return state
    }
    if (
      target.splitDirection &&
      isPaneColumnSplitDropNoOp({
        sourceGroupId,
        targetGroupId: target.groupId,
        splitDirection: target.splitDirection,
        sourceTabCount: sourceGroup.tabOrder.length - tabIds.length + 1,
        layout: state.layoutByWorktree[worktreeId]
      })
    ) {
      return state
    }

    let nextGroups = state.groupsByWorktree[worktreeId] ?? []
    let nextLayoutByWorktree = state.layoutByWorktree
    let nextActiveGroupIdByWorktree = state.activeGroupIdByWorktree
    let resolvedTargetGroupId = target.groupId
    if (target.splitDirection) {
      const newGroupId = createBrowserUuid()
      const newGroup: TabGroup = {
        id: newGroupId,
        worktreeId,
        activeTabId: null,
        tabOrder: []
      }
      const currentLayout =
        nextLayoutByWorktree[worktreeId] ?? ({ type: 'leaf', groupId: target.groupId } as const)
      const replacement = buildSplitNode(
        target.groupId,
        newGroupId,
        target.splitDirection === 'left' || target.splitDirection === 'right'
          ? 'horizontal'
          : 'vertical',
        target.splitDirection === 'left' || target.splitDirection === 'up' ? 'first' : 'second'
      )
      resolvedTargetGroupId = newGroupId
      nextGroups = [...nextGroups, newGroup]
      nextLayoutByWorktree = {
        ...nextLayoutByWorktree,
        [worktreeId]: replaceLeaf(currentLayout, target.groupId, replacement)
      }
      nextActiveGroupIdByWorktree = {
        ...nextActiveGroupIdByWorktree,
        [worktreeId]: newGroupId
      }
    }

    const dedupedSourceGroupOrder = dedupeTabOrder(sourceGroup.tabOrder)
    const sourceOrder = dedupedSourceGroupOrder.filter((id) => !memberIds.has(id))
    const destinationGroup =
      nextGroups.find((group) => group.id === resolvedTargetGroupId) ?? targetGroup
    const targetOrder = dedupeTabOrder(destinationGroup.tabOrder.filter((id) => !memberIds.has(id)))
    const targetIndex = Math.max(
      0,
      Math.min(target.index ?? targetOrder.length, targetOrder.length)
    )
    targetOrder.splice(targetIndex, 0, ...tabIds)
    const activeTabId =
      sourceGroup.activeTabId && memberIds.has(sourceGroup.activeTabId)
        ? sourceGroup.activeTabId
        : tabIds[0]
    const sourceRecentTabIds = sanitizeRecentTabIds(sourceGroup.recentTabIds, sourceOrder)
    const tabs = state.unifiedTabsByWorktree[worktreeId] ?? []
    const pinnedTabIds = new Set(tabs.filter((tab) => tab.isPinned).map((tab) => tab.id))
    nextGroups = nextGroups.map((group) => {
      if (group.id === sourceGroupId) {
        return applyTransferredTabClusterMembership(
          {
            ...group,
            activeTabId:
              group.activeTabId && memberIds.has(group.activeTabId)
                ? pickNextActiveTab(
                    dedupedSourceGroupOrder.filter(
                      (id) => !memberIds.has(id) || id === group.activeTabId
                    ),
                    sourceGroup.recentTabIds,
                    group.activeTabId
                  )
                : group.activeTabId,
            tabOrder: sourceOrder,
            recentTabIds: sourceRecentTabIds
          },
          tabIds,
          null,
          pinnedTabIds
        )
      }
      if (group.id === resolvedTargetGroupId) {
        const nextGroup = {
          ...group,
          activeTabId,
          tabOrder: targetOrder,
          recentTabIds: pushRecentTabId(
            sanitizeRecentTabIds(group.recentTabIds, targetOrder),
            activeTabId
          )
        }
        return carriedCluster
          ? normalizeTabGroupClusters(
              {
                ...nextGroup,
                tabClusters: mergeTabClusterRecords(group.tabClusters, [carriedCluster])
              },
              pinnedTabIds
            )
          : applyTransferredTabClusterMembership(
              nextGroup,
              tabIds,
              isSplitDrop ? null : target.clusterId,
              pinnedTabIds
            )
      }
      return group
    })

    if (sourceOrder.length === 0) {
      nextGroups = nextGroups.filter((group) => group.id !== sourceGroupId)
      const collapsedState = collapseGroupLayout(
        nextLayoutByWorktree,
        nextActiveGroupIdByWorktree,
        worktreeId,
        sourceGroupId,
        resolvedTargetGroupId
      )
      nextLayoutByWorktree = collapsedState.layoutByWorktree
      nextActiveGroupIdByWorktree = collapsedState.activeGroupIdByWorktree
      if (carriedCluster) {
        nextActiveGroupIdByWorktree = {
          ...nextActiveGroupIdByWorktree,
          [worktreeId]: resolvedTargetGroupId
        }
      }
    } else {
      nextActiveGroupIdByWorktree = {
        ...nextActiveGroupIdByWorktree,
        [worktreeId]: resolvedTargetGroupId
      }
    }

    const nextTabs = tabs.map((tab) =>
      memberIds.has(tab.id) ? { ...tab, groupId: resolvedTargetGroupId } : tab
    )
    const unifiedTabsByWorktree = {
      ...state.unifiedTabsByWorktree,
      [worktreeId]: carriedCluster
        ? applyTabOrderSortValues(applyTabOrderSortValues(nextTabs, sourceOrder), targetOrder)
        : nextTabs
    }
    const groupsByWorktree = { ...state.groupsByWorktree, [worktreeId]: nextGroups }
    let recentQuickCommandIdByGroup = state.recentQuickCommandIdByGroup
    if (carriedCluster && !sourceOrder.length) {
      recentQuickCommandIdByGroup = { ...recentQuickCommandIdByGroup }
      delete recentQuickCommandIdByGroup[sourceGroupId]
    }
    const patch = {
      unifiedTabsByWorktree,
      groupsByWorktree,
      layoutByWorktree: nextLayoutByWorktree,
      activeGroupIdByWorktree: nextActiveGroupIdByWorktree,
      recentQuickCommandIdByGroup
    }
    moved = true
    return {
      ...patch,
      ...(state.activeWorktreeId === worktreeId
        ? buildActiveSurfacePatch({ ...state, ...patch }, worktreeId, resolvedTargetGroupId)
        : {})
    }
  })
  if (moved) {
    get().recordFeatureInteraction?.('terminal-tabs')
    get().recordFeatureInteraction?.('tab-splits')
  }
  return moved
}

export function createTabsDropActions(
  set: TabsSliceSet,
  get: TabsSliceGet
): Pick<TabsSlice, 'dropUnifiedTab'> {
  return {
    dropUnifiedTab: (tabId, target) => {
      const state = get()
      const foundTab = findTabAndWorktree(state.unifiedTabsByWorktree, tabId)
      if (!foundTab) {
        return false
      }
      if (target.clusterId && !target.splitDirection) {
        const foundTarget = findGroupAndWorktree(state.groupsByWorktree, target.groupId)
        if (
          foundTarget?.worktreeId === foundTab.worktreeId &&
          foundTarget.group.tabClusters?.some((cluster) => cluster.id === target.clusterId)
        ) {
          promoteClusterPreviewTabs(get, foundTab.tab.groupId, [tabId])
        }
      }
      return moveTabsToPane(set, get, foundTab.worktreeId, foundTab.tab.groupId, [tabId], target)
    }
  }
}
