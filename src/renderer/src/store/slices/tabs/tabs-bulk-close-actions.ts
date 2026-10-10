import type { TabsSlice, TabsSliceGet, TabsSliceSet } from './tabs-slice-contract'
import { findGroupForTab, findTabAndWorktree } from '../tab-group-state'

export function createTabsBulkCloseActions(
  _set: TabsSliceSet,
  get: TabsSliceGet
): Pick<TabsSlice, 'closeOtherTabs' | 'closeTabsToRight' | 'closeTabsToLeft'> {
  return {
    closeOtherTabs: (tabId) => {
      const state = get()
      const found = findTabAndWorktree(state.unifiedTabsByWorktree, tabId)
      if (!found) {
        return []
      }
      const { tab, worktreeId } = found
      const group = findGroupForTab(state.groupsByWorktree, worktreeId, tab.groupId)
      if (!group) {
        return []
      }
      const closedIds = (state.unifiedTabsByWorktree[worktreeId] ?? [])
        .filter((item) => item.groupId === group.id && item.id !== tabId && !item.isPinned)
        .map((item) => item.id)
      for (const id of closedIds) {
        get().closeUnifiedTab(id)
      }
      return closedIds
    },

    closeTabsToRight: (tabId) => {
      const state = get()
      const found = findTabAndWorktree(state.unifiedTabsByWorktree, tabId)
      if (!found) {
        return []
      }
      const { tab, worktreeId } = found
      const group = findGroupForTab(state.groupsByWorktree, worktreeId, tab.groupId)
      if (!group) {
        return []
      }
      const index = group.tabOrder.indexOf(tabId)
      if (index === -1) {
        return []
      }
      const closableIds = group.tabOrder
        .slice(index + 1)
        .filter(
          (id) =>
            !(state.unifiedTabsByWorktree[worktreeId] ?? []).find(
              (candidate) => candidate.id === id
            )?.isPinned
        )
      for (const id of closableIds) {
        get().closeUnifiedTab(id)
      }
      return closableIds
    },

    closeTabsToLeft: (tabId) => {
      const state = get()
      const found = findTabAndWorktree(state.unifiedTabsByWorktree, tabId)
      if (!found) {
        return []
      }
      const { tab, worktreeId } = found
      const group = findGroupForTab(state.groupsByWorktree, worktreeId, tab.groupId)
      if (!group) {
        return []
      }
      const index = group.tabOrder.indexOf(tabId)
      if (index === -1) {
        return []
      }
      const closableIds = group.tabOrder
        .slice(0, index)
        .filter(
          (id) =>
            !(state.unifiedTabsByWorktree[worktreeId] ?? []).find(
              (candidate) => candidate.id === id
            )?.isPinned
        )
      for (const id of closableIds) {
        get().closeUnifiedTab(id)
      }
      return closableIds
    }
  }
}
