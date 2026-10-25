import type { BrowserFocusTarget } from '../components/browser-pane/host-guest/browser-focus'
import type { WorkspaceVisibleTabType } from '../../../shared/tab-types'

/** Capture focus before Radix mounts the modal; document.activeElement no longer identifies the return surface at close. */
export type ModalReturnFocusSurface = {
  tabType: WorkspaceVisibleTabType
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
  | { kind: 'surface' }
  | { kind: 'none' }

// Route webContents focus through browser requests; use surface-specific DOM focus elsewhere so hidden xterm cannot steal it.
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
  if (captured.worktreeId) {
    return { kind: 'surface' }
  }
  return { kind: 'none' }
}
