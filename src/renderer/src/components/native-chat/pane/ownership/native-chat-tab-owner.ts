import {
  chatWorkspaceByTabId,
  chatWorkspaceByTabId as findTerminalTabWorktreeId
} from '../../../../lib/structured-chat-tab-index'
import type { AppState } from '../../../../store/types'

type NativeChatTabOwnerState = Pick<AppState, 'tabsByWorktree'> & {
  unifiedTabsByWorktree?: AppState['unifiedTabsByWorktree']
}

/** The workspace that owns a native chat tab, independent of whether its directory is known. */
export function findNativeChatTabOwnerWorktreeId(
  state: NativeChatTabOwnerState,
  tabId: string
): string | null {
  return (
    findTerminalTabWorktreeId(state.tabsByWorktree, tabId) ??
    chatWorkspaceByTabId(state.unifiedTabsByWorktree, tabId)
  )
}

export function createNativeChatTabOwnerSelector(tabId: string) {
  let terminalTabs: NativeChatTabOwnerState['tabsByWorktree'] | null = null
  let unifiedTabs: NativeChatTabOwnerState['unifiedTabsByWorktree']
  let owner: string | null = null
  return (state: NativeChatTabOwnerState) => {
    // Hidden chats still subscribe; ownership changes only with the immutable tab maps.
    if (terminalTabs !== state.tabsByWorktree || unifiedTabs !== state.unifiedTabsByWorktree) {
      owner = findNativeChatTabOwnerWorktreeId(state, tabId)
      terminalTabs = state.tabsByWorktree
      unifiedTabs = state.unifiedTabsByWorktree
    }
    return owner
  }
}
