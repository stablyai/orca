import type { AppState } from '@/store/types'

export type TerminalTabShownState = Pick<
  AppState,
  | 'activeView'
  | 'activeWorktreeId'
  | 'activeTabType'
  | 'activeTabId'
  | 'activeGroupIdByWorktree'
  | 'unifiedTabsByWorktree'
>

/**
 * The user has this terminal tab in front of them: the terminal view (not Settings or Activity),
 * its worktree, a terminal surface (not a browser or editor), the tab itself, in the focused group.
 */
export function isTerminalTabShown(
  state: TerminalTabShownState,
  worktreeId: string,
  tabId: string
): boolean {
  if (
    state.activeView !== 'terminal' ||
    state.activeWorktreeId !== worktreeId ||
    state.activeTabType !== 'terminal' ||
    state.activeTabId !== tabId
  ) {
    return false
  }
  const groupId = state.unifiedTabsByWorktree[worktreeId]?.find(
    (tab) => tab.contentType === 'terminal' && tab.entityId === tabId
  )?.groupId
  const focusedGroupId = state.activeGroupIdByWorktree[worktreeId]
  return !groupId || !focusedGroupId || groupId === focusedGroupId
}

/** Nothing else holds focus: it is nowhere, or still inside the given terminal tab. */
export function isFocusUnclaimed(...withinTabIds: string[]): boolean {
  const active = document.activeElement
  if (!active || active === document.body || !active.isConnected) {
    return true
  }
  return withinTabIds.some(
    (tabId) => active.closest(`[data-terminal-tab-id="${CSS.escape(tabId)}"]`) !== null
  )
}
