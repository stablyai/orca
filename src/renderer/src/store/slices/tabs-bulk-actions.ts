import type { Tab, TabGroup } from '../../../../shared/types'
import { findTabAndWorktree, findGroupForTab, updateGroup } from './tabs-helpers'

type TabsBulkState = {
  unifiedTabsByWorktree: Record<string, Tab[]>
  groupsByWorktree: Record<string, TabGroup[]>
}

type SetGet = {
  set: (fn: (s: TabsBulkState) => Partial<TabsBulkState>) => void
  get: () => TabsBulkState
}

export function createCloseOtherTabs({ set, get }: SetGet) {
  return (tabId: string): string[] => {
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

    const tabs = state.unifiedTabsByWorktree[worktreeId] ?? []
    const closedIds = tabs
      .filter((t) => t.id !== tabId && !t.isPinned && t.groupId === group.id)
      .map((t) => t.id)

    if (closedIds.length === 0) {
      return []
    }

    const closedSet = new Set(closedIds)

    set((s) => {
      const currentTabs = s.unifiedTabsByWorktree[worktreeId] ?? []
      const remainingTabs = currentTabs.filter((t) => !closedSet.has(t.id))
      const remainingOrder = group.tabOrder.filter((tid) => !closedSet.has(tid))
      const updatedGroupObj: TabGroup = { ...group, activeTabId: tabId, tabOrder: remainingOrder }

      return {
        unifiedTabsByWorktree: { ...s.unifiedTabsByWorktree, [worktreeId]: remainingTabs },
        groupsByWorktree: {
          ...s.groupsByWorktree,
          [worktreeId]: updateGroup(s.groupsByWorktree[worktreeId] ?? [], updatedGroupObj)
        }
      }
    })

    return closedIds
  }
}

export function createCloseTabsToRight({ set, get }: SetGet) {
  return (tabId: string): string[] => {
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

    const idx = group.tabOrder.indexOf(tabId)
    if (idx === -1) {
      return []
    }

    const idsToRight = group.tabOrder.slice(idx + 1)
    const tabs = state.unifiedTabsByWorktree[worktreeId] ?? []
    const tabMap = new Map(tabs.map((t) => [t.id, t]))

    const closedIds = idsToRight.filter((tid) => {
      const t = tabMap.get(tid)
      return t && !t.isPinned
    })

    if (closedIds.length === 0) {
      return []
    }

    const closedSet = new Set(closedIds)

    set((s) => {
      const currentTabs = s.unifiedTabsByWorktree[worktreeId] ?? []
      const remainingTabs = currentTabs.filter((t) => !closedSet.has(t.id))
      const remainingOrder = group.tabOrder.filter((tid) => !closedSet.has(tid))

      const newActiveTabId = closedSet.has(group.activeTabId ?? '') ? tabId : group.activeTabId
      const updatedGroupObj: TabGroup = {
        ...group,
        activeTabId: newActiveTabId,
        tabOrder: remainingOrder
      }

      return {
        unifiedTabsByWorktree: { ...s.unifiedTabsByWorktree, [worktreeId]: remainingTabs },
        groupsByWorktree: {
          ...s.groupsByWorktree,
          [worktreeId]: updateGroup(s.groupsByWorktree[worktreeId] ?? [], updatedGroupObj)
        }
      }
    })

    return closedIds
  }
}
