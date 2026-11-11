import {
  afterPendingTabs,
  isPendingTab,
  isTabClosePending
} from '@/runtime/workspace-layout/intents/layout-owner-pending-tabs'
import { editorTabsRetirement } from '../editor/tabs/editor-tab-retirement'
import { editorTabWorkspace } from '../editor/tabs/workspace-editor-files'
import type { TabsSlice, TabsSliceGet, TabsSliceSet } from './tabs-slice-contract'
import { findGroupForTab, findTabAndWorktree } from './tab-group-state'

export function createTabsBulkCloseActions(
  set: TabsSliceSet,
  get: TabsSliceGet
): Pick<TabsSlice, 'closeUnifiedTabs' | 'closeOtherTabs' | 'closeTabsToRight' | 'closeTabsToLeft'> {
  return {
    closeUnifiedTabs: (tabIds) => {
      const before = get()
      const selected = new Set(tabIds)
      const workspaceIds = new Set(
        tabIds.flatMap((id) => {
          const workspaceId = editorTabWorkspace(before.unifiedTabsByWorktree, id)
          return workspaceId ? [workspaceId] : []
        })
      )
      const tabs = [...workspaceIds].flatMap((id) =>
        (before.unifiedTabsByWorktree[id] ?? []).filter(
          (tab) => selected.has(tab.id) && !isTabClosePending(tab.id)
        )
      )
      const retire = editorTabsRetirement(set, get, before, tabs)
      for (const tab of tabs) {
        get().closeUnifiedTab(tab.id, { editorRetirementHandled: true })
      }
      const retireAfterAnswers = (): void => {
        const pending = tabs.filter((tab) => isPendingTab(tab.id)).map((tab) => tab.id)
        if (pending.length > 0) {
          afterPendingTabs(pending, retireAfterAnswers)
        } else {
          retire()
        }
      }
      retireAfterAnswers()
    },
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
      get().closeUnifiedTabs(closedIds)
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
      get().closeUnifiedTabs(closableIds)
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
      get().closeUnifiedTabs(closableIds)
      return closableIds
    }
  }
}
