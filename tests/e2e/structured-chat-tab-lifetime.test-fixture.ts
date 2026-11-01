// Frozen phone policy from 47713a90d85; only imports and exported function names differ.
type SessionTabLike = {
  id: string
  isActive: boolean
}

export type ActiveSessionTabSelectionSource =
  | 'snapshot'
  | 'pending-tab'
  | 'selected-tab'
  | 'navigation-intent'

export type ResolveActiveSessionTabResult<T extends SessionTabLike> = {
  activeTab: T | null
  selectionSource: ActiveSessionTabSelectionSource
  clearPendingActiveSessionTabId: boolean
  retainSelectedSessionTabId: boolean
}

export function resolveActiveSessionTab47713<T extends SessionTabLike>(
  tabs: readonly T[],
  opts: {
    pendingActiveSessionTabId: string | null
    selectedSessionTabId: string | null
    navigationIntent?: 'follow'
  }
): ResolveActiveSessionTabResult<T> {
  const snapshotActive = tabs.find((tab) => tab.isActive) ?? tabs[0] ?? null
  const pendingActiveSessionTabId = opts.pendingActiveSessionTabId
  // Why: targeted follow is the only host action allowed to supersede phone-local intent.
  if (opts.navigationIntent === 'follow') {
    return {
      activeTab: snapshotActive,
      selectionSource: 'navigation-intent',
      clearPendingActiveSessionTabId: pendingActiveSessionTabId !== null,
      retainSelectedSessionTabId: false
    }
  }
  if (pendingActiveSessionTabId) {
    if (snapshotActive?.id === pendingActiveSessionTabId) {
      return {
        activeTab: snapshotActive,
        selectionSource: 'snapshot',
        clearPendingActiveSessionTabId: true,
        retainSelectedSessionTabId: false
      }
    }
    const pendingTab = tabs.find((tab) => tab.id === pendingActiveSessionTabId) ?? null
    if (pendingTab) {
      return {
        activeTab: pendingTab,
        selectionSource: 'pending-tab',
        clearPendingActiveSessionTabId: false,
        retainSelectedSessionTabId: false
      }
    }
  }
  const clearPendingActiveSessionTabId = pendingActiveSessionTabId !== null
  const selectedTab = opts.selectedSessionTabId
    ? (tabs.find((tab) => tab.id === opts.selectedSessionTabId) ?? null)
    : null
  return {
    activeTab: selectedTab ?? snapshotActive,
    selectionSource: selectedTab ? 'selected-tab' : 'snapshot',
    clearPendingActiveSessionTabId,
    // Why: transient browser guest swaps must not erase the device's explicit pick.
    retainSelectedSessionTabId: Boolean(opts.selectedSessionTabId) && !selectedTab
  }
}

import { parsePaneKey } from '../../src/shared/stable-pane-id'
import {
  structuredAgentSessionPaneKey,
  structuredAgentSessionTabId
} from '../../src/shared/agent-session/view/structured-agent-session-projection'
import type { MobileSessionTab } from '../../mobile/src/session/mobile-session-route-types'

// Keep native/web navigation’s pane lookup separate: importing the native sibling by name on web resolves back to the web file itself.
export function notificationPaneTab47713(tabs: readonly MobileSessionTab[], paneKey: string) {
  const pane = parsePaneKey(paneKey)
  if (!pane) {
    return undefined
  }
  return tabs.find((tab) =>
    tab.type === 'terminal'
      ? (tab.parentTabId ?? tab.id) === pane.tabId && tab.leafId === pane.leafId
      : tab.type === 'agent-session' &&
        (tab.id === pane.tabId ||
          structuredAgentSessionPaneKey(
            structuredAgentSessionTabId(tab.sessionId),
            tab.sessionId
          ) === paneKey)
  )
}
