import type { BrowserFocusTarget } from '../components/browser-pane/browser-focus'

// The surface that held focus before a modal (QuickOpen, Cmd+J, ...) opened.
// Captured at open time because Radix steals document focus once the dialog
// mounts, so the raw activeElement is gone by close time.
export type ModalReturnFocusSurface = {
  tabType: 'browser' | 'editor' | 'terminal' | 'simulator'
  worktreeId: string | null
  browserPageId: string | null
  browserTarget: BrowserFocusTarget
}

export type ModalReturnFocusAction =
  | { kind: 'browser'; pageId: string; target: BrowserFocusTarget }
  | { kind: 'surface' }
  | { kind: 'none' }

// Why: a browser page lives in a separate webContents, so focus must route
// through the browser focus request channel; terminal/editor share the DOM and
// can be focused directly. Mirrors WorktreeJumpPalette's close-time branching.
export function resolveModalReturnFocusAction(
  captured: ModalReturnFocusSurface | null
): ModalReturnFocusAction {
  if (!captured) {
    return { kind: 'none' }
  }
  if (captured.tabType === 'browser' && captured.browserPageId) {
    return { kind: 'browser', pageId: captured.browserPageId, target: captured.browserTarget }
  }
  if (captured.worktreeId) {
    return { kind: 'surface' }
  }
  return { kind: 'none' }
}
