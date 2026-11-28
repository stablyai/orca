import {
  chatWorkspaceByTabId,
  chatWorkspaceByTabId as findTerminalTabWorktreeId
} from '../../../../lib/agent-session/tab-identity/structured-chat-tab-index'
import type { AppState } from '../../../../store/types'

type NativeChatTabOwnerState = Pick<AppState, 'tabsByWorktree'> & {
  unifiedTabsByWorktree?: AppState['unifiedTabsByWorktree']
}

const VIEWED_CHAT_TAB_PREFIX = 'viewed-chat:'

/** A chat shown from another person's tab list: its own pane id here (never one of this window's
 *  tabs), naming the workspace its tab is in, so workspace-keyed chat features resolve as for a tab. */
export function viewedChatTabId(workspaceId: string, tabId: string): string {
  return `${VIEWED_CHAT_TAB_PREFIX}${encodeURIComponent(workspaceId)}:${encodeURIComponent(tabId)}`
}

function viewedChatTabWorkspaceId(tabId: string): string | null {
  return tabId.startsWith(VIEWED_CHAT_TAB_PREFIX)
    ? decodeURIComponent(tabId.slice(VIEWED_CHAT_TAB_PREFIX.length).split(':')[0] ?? '')
    : null
}

/** The workspace that owns a native chat tab, independent of whether its directory is known. */
export function findNativeChatTabOwnerWorktreeId(
  state: NativeChatTabOwnerState,
  tabId: string
): string | null {
  return (
    viewedChatTabWorkspaceId(tabId) ??
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
