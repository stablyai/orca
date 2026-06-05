import { parsePaneKey } from '../../../../shared/stable-pane-id'
import type { TerminalLayoutSnapshot } from '../../../../shared/types'

type NotificationPaneVisibilityState = {
  activeWorktreeId: string | null
  activeTabId: string | null
  terminalLayoutsByTabId?: Record<string, TerminalLayoutSnapshot>
}

export function isOrcaWindowForegroundFocused(): boolean {
  if (typeof document === 'undefined') {
    return true
  }
  return document.visibilityState === 'visible' && document.hasFocus()
}

export function isVisibleForegroundPaneKey(
  state: NotificationPaneVisibilityState,
  worktreeId: string,
  paneKey: string
): boolean {
  if (!isOrcaWindowForegroundFocused() || state.activeWorktreeId !== worktreeId) {
    return false
  }

  const parsed = parsePaneKey(paneKey)
  if (!parsed || state.activeTabId !== parsed.tabId) {
    return false
  }

  return state.terminalLayoutsByTabId?.[parsed.tabId]?.activeLeafId === parsed.leafId
}
