import type { TerminalTab } from '../../../../../shared/workspace-layout/terminal-tab-types'
import type { AppState } from '../../types'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../../shared/constants'

const EMPTY_TABS: TerminalTab[] = []

type FloatingWorkspaceUnreadState = Pick<
  AppState,
  'tabsByWorktree' | 'unreadTerminalTabs' | 'unreadAgentCompletionPanes'
>

type FloatingWorkspaceUnreadCache = {
  tabs: NonNullable<AppState['tabsByWorktree'][string]>
  unreadTerminalTabs: AppState['unreadTerminalTabs']
  unreadAgentCompletionPanes: AppState['unreadAgentCompletionPanes']
  hasUnread: boolean
}

let floatingWorkspaceUnreadCache: FloatingWorkspaceUnreadCache | null = null

/** Derive floating attention from live tabs’ bell/completion maps, clearing on engagement/close; stale removed-tab entries cannot light it. Share reference-cached projection across mounted launcher/overlay to avoid repeated scans. */
export function selectFloatingWorkspaceHasUnread(state: FloatingWorkspaceUnreadState): boolean {
  const tabs = state.tabsByWorktree[FLOATING_TERMINAL_WORKTREE_ID] ?? EMPTY_TABS
  const cached = floatingWorkspaceUnreadCache
  if (
    cached &&
    cached.tabs === tabs &&
    cached.unreadTerminalTabs === state.unreadTerminalTabs &&
    cached.unreadAgentCompletionPanes === state.unreadAgentCompletionPanes
  ) {
    return cached.hasUnread
  }

  let hasUnread = false
  if (tabs.length > 0) {
    const floatingTabIds = new Set<string>()
    for (const tab of tabs) {
      if (state.unreadTerminalTabs[tab.id]) {
        hasUnread = true
        break
      }
      floatingTabIds.add(tab.id)
    }
    if (!hasUnread) {
      // paneKey is `${tabId}:${leafId}` and tabIds never contain ":", so the
      // prefix up to the first ":" is the owning tab id.
      for (const paneKey of Object.keys(state.unreadAgentCompletionPanes)) {
        const separatorIndex = paneKey.indexOf(':')
        const tabId = separatorIndex === -1 ? paneKey : paneKey.slice(0, separatorIndex)
        if (floatingTabIds.has(tabId)) {
          hasUnread = true
          break
        }
      }
    }
  }

  floatingWorkspaceUnreadCache = {
    tabs,
    unreadTerminalTabs: state.unreadTerminalTabs,
    unreadAgentCompletionPanes: state.unreadAgentCompletionPanes,
    hasUnread
  }
  return hasUnread
}

export function resetFloatingWorkspaceUnreadSelectorCacheForTest(): void {
  floatingWorkspaceUnreadCache = null
}
