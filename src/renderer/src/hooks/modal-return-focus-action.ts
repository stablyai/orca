import type { BrowserFocusTarget } from '../components/browser-pane/browser-focus'

// The surface that held focus before a modal (QuickOpen, Cmd+J, ...) opened.
// Captured at open time because Radix steals document focus once the dialog
// mounts, so the raw activeElement is gone by close time.
export type ModalReturnFocusSurface = {
  tabType: 'browser' | 'editor' | 'terminal' | 'simulator' | 'tasks'
  worktreeId: string | null
  browserPageId: string | null
  browserTarget: BrowserFocusTarget
  terminalTabId: string | null
  terminalLeafId: string | null
}

export type ModalReturnFocusAction =
  | { kind: 'browser'; pageId: string; target: BrowserFocusTarget }
  | { kind: 'terminal'; tabId: string; leafId: string | null }
  | { kind: 'editor' }
  | { kind: 'simulator' }
  | { kind: 'tasks' }
  | { kind: 'surface' }
  | { kind: 'none' }

// Why: a browser page lives in a separate webContents, so focus must route
// through the browser focus request channel. Other surfaces need type-specific
// DOM focus so a hidden xterm cannot steal focus from the active editor.
export function resolveModalReturnFocusAction(
  captured: ModalReturnFocusSurface | null
): ModalReturnFocusAction {
  if (!captured) {
    return { kind: 'none' }
  }
  if (captured.tabType === 'browser' && captured.browserPageId) {
    return { kind: 'browser', pageId: captured.browserPageId, target: captured.browserTarget }
  }
  if (captured.tabType === 'terminal' && captured.terminalTabId) {
    return { kind: 'terminal', tabId: captured.terminalTabId, leafId: captured.terminalLeafId }
  }
  if (captured.tabType === 'editor' && captured.worktreeId) {
    return { kind: 'editor' }
  }
  if (captured.tabType === 'simulator' && captured.worktreeId) {
    return { kind: 'simulator' }
  }
  // Why: tasks panes are self-contained like the simulator — falling through
  // to 'surface' would focus a hidden xterm/editor textarea instead of
  // returning focus to the tasks pane.
  if (captured.tabType === 'tasks' && captured.worktreeId) {
    return { kind: 'tasks' }
  }
  if (captured.worktreeId) {
    return { kind: 'surface' }
  }
  return { kind: 'none' }
}
