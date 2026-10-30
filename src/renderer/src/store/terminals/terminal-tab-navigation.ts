import { resolveActiveTabOwnerWorktreeId } from '../slices/active-tab-owner-worktree'
import { getTerminalTabOwnerWorktreeId } from '../slices/terminal-tab-owner-index'
import type { TerminalSlice, TerminalStoreGet, TerminalStoreSet } from './terminal-state'
import { ownsGlobalSelection } from '../global-selection-owner'

export function createTerminalTabNavigationActions(
  set: TerminalStoreSet,
  get: TerminalStoreGet
): Pick<
  TerminalSlice,
  | 'reorderTabs'
  | 'setTabBarOrder'
  | 'setActiveTab'
  | 'setActiveTabForWorktree'
  | 'getTerminalTabOwnerWorktreeId'
> {
  return {
    reorderTabs: (worktreeId, tabIds) => {
      set((s) => {
        const tabs = s.tabsByWorktree[worktreeId] ?? []
        const tabMap = new Map(tabs.map((t) => [t.id, t]))
        const orderedSet = new Set(tabIds)
        const missingTabs = tabs.filter((t) => !orderedSet.has(t.id))
        const reordered = [
          ...tabIds.map((id) => tabMap.get(id)!).filter(Boolean),
          ...missingTabs
        ].map((tab, i) => ({ ...tab, sortOrder: i }))
        return {
          tabsByWorktree: { ...s.tabsByWorktree, [worktreeId]: reordered }
        }
      })
    },
    setTabBarOrder: (worktreeId, order) => {
      set((s) => {
        const newTabBarOrder = { ...s.tabBarOrderByWorktree, [worktreeId]: order }
        // Keep terminal tab sortOrder in sync for persistence
        const tabs = s.tabsByWorktree[worktreeId]
        if (!tabs) {
          return { tabBarOrderByWorktree: newTabBarOrder }
        }
        const tabMap = new Map(tabs.map((t) => [t.id, t]))
        const terminalIdsInOrder = order.filter((id) => tabMap.has(id))
        const orderedSet = new Set(terminalIdsInOrder)
        const missingTabs = tabs.filter((t) => !orderedSet.has(t.id))
        const updatedTabs = [
          ...terminalIdsInOrder.map((id) => tabMap.get(id)!).filter(Boolean),
          ...missingTabs
        ].map((tab, i) => ({ ...tab, sortOrder: i }))
        return {
          tabBarOrderByWorktree: newTabBarOrder,
          tabsByWorktree: { ...s.tabsByWorktree, [worktreeId]: updatedTabs }
        }
      })
    },
    setActiveTab: (tabId) => {
      let tabOwnerWorktreeId: string | null = null
      set((s) => {
        tabOwnerWorktreeId = resolveActiveTabOwnerWorktreeId(
          s.tabsByWorktree,
          s.activeWorktreeId,
          tabId
        )
        const isActiveWorktreeTab =
          tabOwnerWorktreeId !== null && ownsGlobalSelection(s, tabOwnerWorktreeId)
        return {
          activeTabId: isActiveWorktreeTab ? tabId : s.activeTabId,
          // Preserve map identity on redundant activation; duplicate tab IDs can prevent convergence and retrigger Terminal’s repair effect into React #185.
          activeTabIdByWorktree:
            tabOwnerWorktreeId !== null && s.activeTabIdByWorktree[tabOwnerWorktreeId] !== tabId
              ? { ...s.activeTabIdByWorktree, [tabOwnerWorktreeId]: tabId }
              : s.activeTabIdByWorktree
        }
      })
      const state = get()
      const ownerUnifiedTabs =
        tabOwnerWorktreeId !== null &&
        Object.hasOwn(state.unifiedTabsByWorktree, tabOwnerWorktreeId)
          ? state.unifiedTabsByWorktree[tabOwnerWorktreeId]
          : []
      // Duplicate entity IDs must use the owner chosen above.
      const item =
        ownerUnifiedTabs.find(
          (entry) => entry.contentType === 'terminal' && entry.entityId === tabId
        ) ??
        Object.values(state.unifiedTabsByWorktree)
          .flat()
          .find((entry) => entry.contentType === 'terminal' && entry.entityId === tabId)
      if (item) {
        state.activateTab(
          item.id,
          tabOwnerWorktreeId !== null ? { worktreeId: tabOwnerWorktreeId } : undefined
        )
      }
    },
    getTerminalTabOwnerWorktreeId: (tabId) =>
      getTerminalTabOwnerWorktreeId(get().tabsByWorktree, tabId),
    setActiveTabForWorktree: (worktreeId, tabId) => {
      set((s) => ({
        activeTabIdByWorktree: {
          ...s.activeTabIdByWorktree,
          [worktreeId]: tabId
        }
      }))
    }
  }
}
