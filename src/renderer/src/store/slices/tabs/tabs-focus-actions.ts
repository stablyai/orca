import type { TabsSlice, TabsSliceGet, TabsSliceSet } from './tabs-slice-contract'
import {
  findTabAndWorktree,
  findTabByEntityInGroup,
  pushRecentTabId,
  sanitizeRecentTabIds
} from '../tab-group-state'

export function createTabsFocusActions(
  _set: TabsSliceSet,
  get: TabsSliceGet
): Pick<TabsSlice, 'getTab' | 'getActiveTab' | 'findTabForEntityInGroup' | 'activateTab'> {
  const set = _set
  return {
    getTab: (tabId) => findTabAndWorktree(get().unifiedTabsByWorktree, tabId)?.tab ?? null,

    getActiveTab: (worktreeId) => {
      const state = get()
      const groupId = state.activeGroupIdByWorktree[worktreeId]
      const group = (state.groupsByWorktree[worktreeId] ?? []).find(
        (candidate) => candidate.id === groupId
      )
      if (!group?.activeTabId) {
        return null
      }
      return (
        (state.unifiedTabsByWorktree[worktreeId] ?? []).find(
          (tab) => tab.id === group.activeTabId
        ) ?? null
      )
    },

    findTabForEntityInGroup: (worktreeId, groupId, entityId, contentType) =>
      findTabByEntityInGroup(
        get().unifiedTabsByWorktree,
        worktreeId,
        groupId,
        entityId,
        contentType
      ),

    activateTab: (tabId, opts) => {
      set((state) => {
        const scopedWorktreeId = opts?.worktreeId
        let found: ReturnType<typeof findTabAndWorktree>
        if (scopedWorktreeId !== undefined) {
          const scopedTabs = Object.hasOwn(state.unifiedTabsByWorktree, scopedWorktreeId)
            ? state.unifiedTabsByWorktree[scopedWorktreeId]
            : []
          const scopedTab = scopedTabs.find((tab) => tab.id === tabId)
          found = scopedTab ? { tab: scopedTab, worktreeId: scopedWorktreeId } : null
        } else {
          found = findTabAndWorktree(state.unifiedTabsByWorktree, tabId)
        }
        if (!found) {
          return {}
        }
        const { tab, worktreeId } = found
        // Why: activating a terminal tab dismisses its tab-level bell — the user has moved their eyes here.
        // Why (activeWorktree guard below): only when the tab is in the active worktree, else the unseen signal is lost (mirrors focusGroup).
        const terminalEntityId = tab.contentType === 'terminal' ? tab.entityId : null
        const nextUnreadTerminalTabs =
          state.activeWorktreeId === worktreeId &&
          terminalEntityId &&
          state.unreadTerminalTabs[terminalEntityId]
            ? (() => {
                const copy = { ...state.unreadTerminalTabs }
                delete copy[terminalEntityId]
                return copy
              })()
            : state.unreadTerminalTabs
        return {
          unifiedTabsByWorktree: {
            ...state.unifiedTabsByWorktree,
            [worktreeId]: (state.unifiedTabsByWorktree[worktreeId] ?? []).map((item) =>
              item.id === tabId
                ? {
                    ...item,
                    isPreview: opts?.preservePreview ? item.isPreview : false,
                    lastFocusedAt: Date.now()
                  }
                : item
            )
          },
          groupsByWorktree: {
            ...state.groupsByWorktree,
            [worktreeId]: (state.groupsByWorktree[worktreeId] ?? []).map((group) =>
              group.id === tab.groupId
                ? {
                    ...group,
                    activeTabId: tabId,
                    // Why: track every activation in the group's MRU so closeUnifiedTab returns to the previous tab; sanitize to prune removed ids.
                    recentTabIds: pushRecentTabId(
                      sanitizeRecentTabIds(group.recentTabIds, group.tabOrder),
                      tabId
                    )
                  }
                : group
            )
          },
          activeGroupIdByWorktree: {
            ...state.activeGroupIdByWorktree,
            [worktreeId]: tab.groupId
          },
          // Why: skip writing unreadTerminalTabs when the reference is unchanged, avoiding a no-op alloc that re-runs full-state selectors.
          ...(nextUnreadTerminalTabs !== state.unreadTerminalTabs
            ? { unreadTerminalTabs: nextUnreadTerminalTabs }
            : {})
        }
      })
    }
  }
}
