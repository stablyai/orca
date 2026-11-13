import type { TabsSlice, TabsSliceGet } from './tabs-slice-contract'
import { findTabAndWorktree } from './tab-group-state'
import { partitionPinnedTabOrder } from '../../../../../shared/workspace-layout/tab-groups/tab-order'

export function createTabsRecencyActions(
  get: TabsSliceGet
): Pick<TabsSlice, 'captureTabInteraction' | 'getTabCycleOrder' | 'recordTabInteraction'> {
  const pendingInteractions = new Map<string, Map<string, symbol>>()
  let cycle: {
    worktreeId: string
    groupId: string
    order: string[]
    displayedOrder: string[]
    selectedTabId: string | null
  } | null = null

  return {
    captureTabInteraction: (tabId, worktreeId) => {
      const state = get()
      const tab = state.unifiedTabsByWorktree[worktreeId]?.find((tab) => tab.id === tabId)
      if (!tab || state.settings?.tabBarOrderMode !== 'mru') {
        return () => {}
      }
      const groups = pendingInteractions.get(worktreeId) ?? new Map<string, symbol>()
      const token = Symbol()
      groups.set(tab.groupId, token)
      pendingInteractions.set(worktreeId, groups)
      return () => {
        if (groups.get(tab.groupId) === token) {
          get().recordTabInteraction(tabId, { worktreeId })
        }
      }
    },
    getTabCycleOrder: (worktreeId, groupId) => {
      const state = get()
      const group = state.groupsByWorktree[worktreeId]?.find((item) => item.id === groupId)
      if (!group || state.settings?.tabBarOrderMode !== 'mru') {
        cycle = null
        return group?.tabOrder ?? []
      }
      if (
        !cycle ||
        cycle.worktreeId !== worktreeId ||
        cycle.groupId !== groupId ||
        cycle.selectedTabId !== group.activeTabId ||
        cycle.displayedOrder.length !== group.tabOrder.length ||
        !cycle.displayedOrder.every((id, index) => id === group.tabOrder[index])
      ) {
        cycle = {
          worktreeId,
          groupId,
          order: group.tabOrder,
          displayedOrder: group.tabOrder,
          selectedTabId: group.activeTabId
        }
      }
      return cycle.order
    },
    recordTabInteraction: (tabId, opts) => {
      const state = get()
      if (!opts?.cycle) {
        cycle = null
      }
      if (state.settings?.tabBarOrderMode !== 'mru') {
        return
      }
      const scopedTab = opts?.worktreeId
        ? state.unifiedTabsByWorktree[opts.worktreeId]?.find((tab) => tab.id === tabId)
        : undefined
      const found = opts?.worktreeId
        ? scopedTab
          ? { tab: scopedTab, worktreeId: opts.worktreeId }
          : null
        : findTabAndWorktree(state.unifiedTabsByWorktree, tabId)
      if (!found) {
        return
      }
      const { tab, worktreeId } = found
      pendingInteractions.get(worktreeId)?.delete(tab.groupId)
      const tabs = state.unifiedTabsByWorktree[worktreeId]
      const group = state.groupsByWorktree[worktreeId]?.find((item) => item.id === tab.groupId)
      if (!group || !group.tabOrder.includes(tabId)) {
        return
      }
      const order = tab.isPinned
        ? group.tabOrder
        : partitionPinnedTabOrder(group.tabOrder, tabs, tabId)
      if (opts?.cycle && cycle?.worktreeId === worktreeId && cycle.groupId === group.id) {
        cycle.displayedOrder = order
        cycle.selectedTabId = group.activeTabId
      }
      // Repeated typing in the leading tab must not publish another layout change.
      if (order.every((id, index) => id === group.tabOrder[index])) {
        return
      }
      state.reorderUnifiedTabs(group.id, order, { worktreeId, recordInteraction: false })
    }
  }
}
