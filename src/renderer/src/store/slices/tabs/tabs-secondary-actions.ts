import type { TabGroupLayoutNode } from '../../../../../shared/tab-types'
import type { TabsSlice, TabsSliceGet, TabsSliceSet } from './tabs-slice-contract'
import {
  dedupeTabOrder,
  findGroupAndWorktree,
  findTabAndWorktree,
  sanitizeRecentTabIds
} from '../tab-group-state'
import { collapseGroupLayout, findSiblingGroupId, updateSplitRatio } from './tabs-layout'
import { mergeTabClusterRecords, normalizeTabGroupClusters } from './tab-cluster-model'
import { applyTabOrderSortValues } from './tabs-tab-order'
import { buildActiveSurfacePatch } from './tabs-surface'

export function createTabsSecondaryActions(
  set: TabsSliceSet,
  get: TabsSliceGet
): Pick<TabsSlice, 'copyUnifiedTabToGroup' | 'mergeGroupIntoSibling' | 'setTabGroupSplitRatio'> {
  return {
    copyUnifiedTabToGroup: (tabId, targetGroupId, init) => {
      const foundTab = findTabAndWorktree(get().unifiedTabsByWorktree, tabId)
      const foundTarget = findGroupAndWorktree(get().groupsByWorktree, targetGroupId)
      if (!foundTab || !foundTarget || foundTab.worktreeId !== foundTarget.worktreeId) {
        return null
      }
      const { tab, worktreeId } = foundTab
      return get().createUnifiedTab(worktreeId, tab.contentType, {
        entityId: init?.entityId ?? tab.entityId,
        executionHostId: tab.executionHostId,
        label: init?.label ?? tab.label,
        generatedLabel: init?.generatedLabel ?? tab.generatedLabel,
        quickCommandLabel: init?.quickCommandLabel ?? tab.quickCommandLabel,
        customLabel: init?.customLabel ?? tab.customLabel,
        color: init?.color ?? tab.color,
        isPinned: init?.isPinned ?? tab.isPinned,
        id: init?.id,
        targetGroupId
      })
    },

    mergeGroupIntoSibling: (worktreeId, groupId) => {
      let mergedInto: string | null = null
      set((state) => {
        const groups = state.groupsByWorktree[worktreeId] ?? []
        const sourceGroup = groups.find((candidate) => candidate.id === groupId)
        const layout = state.layoutByWorktree[worktreeId]
        if (!sourceGroup || !layout || groups.length <= 1) {
          return state
        }
        const targetGroupId = findSiblingGroupId(layout, groupId)
        const targetGroup = groups.find((candidate) => candidate.id === targetGroupId)
        if (!targetGroup) {
          return state
        }
        const tabs = state.unifiedTabsByWorktree[worktreeId] ?? []
        const sourceTabs = tabs.filter((tab) => tab.groupId === groupId)
        const sourceIds = new Set(sourceTabs.map((tab) => tab.id))
        const sourceOrder = dedupeTabOrder([
          ...sourceGroup.tabOrder.filter((id) => sourceIds.has(id)),
          ...sourceTabs.map((tab) => tab.id)
        ])
        const pinnedTabIds = new Set(tabs.filter((tab) => tab.isPinned).map((tab) => tab.id))
        const combinedOrder = dedupeTabOrder([...targetGroup.tabOrder, ...sourceOrder])
        const tabOrder = [
          ...combinedOrder.filter((id) => pinnedTabIds.has(id)),
          ...combinedOrder.filter((id) => !pinnedTabIds.has(id))
        ]
        const activeTabId =
          targetGroup.activeTabId ?? sourceGroup.activeTabId ?? tabOrder[0] ?? null
        const merged = normalizeTabGroupClusters(
          {
            ...targetGroup,
            tabOrder,
            activeTabId,
            recentTabIds: sanitizeRecentTabIds(
              [...(sourceGroup.recentTabIds ?? []), ...(targetGroup.recentTabIds ?? [])],
              tabOrder
            ),
            tabClusters: mergeTabClusterRecords(targetGroup.tabClusters, sourceGroup.tabClusters)
          },
          pinnedTabIds
        )
        const groupsByWorktree = {
          ...state.groupsByWorktree,
          [worktreeId]: groups
            .filter((group) => group.id !== groupId)
            .map((group) => (group.id === targetGroup.id ? merged : group))
        }
        const unifiedTabsByWorktree = {
          ...state.unifiedTabsByWorktree,
          [worktreeId]: applyTabOrderSortValues(
            tabs.map((tab) => (sourceIds.has(tab.id) ? { ...tab, groupId: targetGroup.id } : tab)),
            tabOrder
          )
        }
        const collapsed = collapseGroupLayout(
          state.layoutByWorktree,
          state.activeGroupIdByWorktree,
          worktreeId,
          groupId,
          targetGroup.id
        )
        const recentQuickCommandIdByGroup = { ...state.recentQuickCommandIdByGroup }
        delete recentQuickCommandIdByGroup[groupId]
        const patch = {
          groupsByWorktree,
          unifiedTabsByWorktree,
          ...collapsed,
          recentQuickCommandIdByGroup
        }
        mergedInto = targetGroup.id
        return {
          ...patch,
          ...(state.activeWorktreeId === worktreeId
            ? buildActiveSurfacePatch({ ...state, ...patch }, worktreeId, targetGroup.id)
            : {})
        }
      })
      if (!mergedInto) {
        return null
      }
      get().recordFeatureInteraction?.('terminal-panes')
      return mergedInto
    },

    setTabGroupSplitRatio: (worktreeId, nodePath, ratio) => {
      set((state) => {
        const currentLayout = state.layoutByWorktree[worktreeId]
        if (!currentLayout) {
          return state
        }
        // Why: an unchanged ratio must not mint fresh root state — every store
        // subscriber wakes on the new reference (STA-3328).
        let targetNode: TabGroupLayoutNode | undefined = currentLayout
        for (const segment of nodePath.length > 0 ? nodePath.split('.') : []) {
          targetNode =
            targetNode &&
            targetNode.type === 'split' &&
            (segment === 'first' || segment === 'second')
              ? targetNode[segment]
              : undefined
        }
        if (!targetNode || targetNode.type !== 'split' || (targetNode.ratio ?? 0.5) === ratio) {
          return state
        }
        return {
          layoutByWorktree: {
            ...state.layoutByWorktree,
            // Why: split ratios belong to the tab-group model (not transient UI), so persist them for restores and multi-step group ops.
            [worktreeId]: updateSplitRatio(
              currentLayout,
              nodePath.length > 0 ? nodePath.split('.') : [],
              ratio
            )
          }
        }
      })
    }
  }
}
