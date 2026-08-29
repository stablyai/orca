import { hasUsableFloatingTerminalPanelViewport } from './floating-terminal-panel-bounds'
import type { FloatingTerminalPanelViewState } from './floating-terminal-panel-view-state'

/**
 * Whether the panel's first rendered rect should be the maximized one.
 *
 * Why this is a decision and not just a flag read: maximized geometry is derived from the
 * live viewport, so restoring it against a viewport too small to hold the panel would pin
 * the terminals to a grid the window is about to leave — the size jump this restore exists
 * to remove. When the viewport cannot answer yet, fall back to the committed bounds and let
 * the ordinary reconcile path maximize once layout is real.
 */
export function shouldRestoreMaximizedPanelBounds(
  viewState: FloatingTerminalPanelViewState | null,
  hasUsableViewport: () => boolean = hasUsableFloatingTerminalPanelViewport
): boolean {
  return viewState?.maximized === true && hasUsableViewport()
}
