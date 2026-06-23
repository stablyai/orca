import { getActiveTabNavOrder } from '@/components/tab-bar/group-tab-order'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'

export type TerminalUnreadMarkingStore = Pick<
  AppState,
  | 'activeGroupIdByWorktree'
  | 'activeTabId'
  | 'activeTabIdByWorktree'
  | 'activeTabType'
  | 'activeTabTypeByWorktree'
  | 'activeWorktreeId'
  | 'browserTabsByWorktree'
  | 'groupsByWorktree'
  | 'markTerminalTabUnread'
  | 'markWorktreeUnread'
  | 'openFiles'
  | 'tabBarOrderByWorktree'
  | 'tabsByWorktree'
  | 'unifiedTabsByWorktree'
>

export function getActiveTerminalTabIdForUnread(
  store: TerminalUnreadMarkingStore,
  worktreeId: string
): string | null {
  const activeGroupId = store.activeGroupIdByWorktree[worktreeId]
  const activeGroup = activeGroupId
    ? (store.groupsByWorktree[worktreeId] ?? []).find((group) => group.id === activeGroupId)
    : undefined
  if (activeGroup?.activeTabId) {
    const visibleActiveTab = getActiveTabNavOrder(store, worktreeId).find(
      (entry) => entry.tabId === activeGroup.activeTabId
    )
    return visibleActiveTab?.type === 'terminal' ? visibleActiveTab.id : null
  }

  const activeTabType =
    store.activeTabTypeByWorktree[worktreeId] ??
    (store.activeWorktreeId === worktreeId ? store.activeTabType : 'terminal')
  if (activeTabType !== 'terminal') {
    return null
  }

  const activeTabId =
    store.activeTabIdByWorktree[worktreeId] ??
    (store.activeWorktreeId === worktreeId ? store.activeTabId : null)
  if (!activeTabId) {
    return null
  }

  return (store.tabsByWorktree[worktreeId] ?? []).some((tab) => tab.id === activeTabId)
    ? activeTabId
    : null
}

export function markTerminalUnreadForWorktree(
  store: TerminalUnreadMarkingStore,
  worktreeId: string
): boolean {
  const tabId = getActiveTerminalTabIdForUnread(store, worktreeId)
  if (!tabId) {
    return false
  }

  // Why: the manual shortcut should create the same tab-level and workspace
  // attention signal as a terminal bell/agent-complete event.
  store.markTerminalTabUnread(tabId)
  store.markWorktreeUnread(worktreeId)
  return true
}

export function markActiveTerminalUnread(worktreeIdOverride?: string): boolean {
  const store = useAppStore.getState()
  const worktreeId = worktreeIdOverride ?? store.activeWorktreeId
  return worktreeId ? markTerminalUnreadForWorktree(store, worktreeId) : false
}
