import type { TabsSlice, TabsSliceGet } from './tabs-slice-contract'
import { findTabAndWorktree } from './tab-group-state'
import { partitionPinnedTabOrder } from '../../../../../shared/workspace-layout/tab-groups/tab-order'

export function createTabsRecencyActions(
  get: TabsSliceGet
): Pick<TabsSlice, 'recordTabInteraction'> {
  return {
    recordTabInteraction: (tabId, opts) => {
      const state = get()
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
      if (!found || found.tab.isPinned) {
        return
      }
      const { tab, worktreeId } = found
      const tabs = state.unifiedTabsByWorktree[worktreeId]
      const group = state.groupsByWorktree[worktreeId]?.find((item) => item.id === tab.groupId)
      if (!group || !group.tabOrder.includes(tabId)) {
        return
      }
      const order = partitionPinnedTabOrder(group.tabOrder, tabs, tabId)
      // Repeated typing in the leading tab must not publish another layout change.
      if (order.every((id, index) => id === group.tabOrder[index])) {
        return
      }
      state.reorderUnifiedTabs(group.id, order, { worktreeId, recordInteraction: false })
    }
  }
}
