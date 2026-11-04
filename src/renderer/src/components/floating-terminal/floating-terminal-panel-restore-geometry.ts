import { hasUsableFloatingTerminalPanelViewport } from './floating-terminal-panel-bounds'
import type { FloatingTerminalPanelViewState } from './floating-terminal-panel-view-state'

/** Defer viewport-derived maximize until sizing is usable to avoid fitting terminals twice and reflowing live TUIs. */
export function shouldRestoreMaximizedPanelBounds(
  viewState: FloatingTerminalPanelViewState | null,
  hasUsableViewport: () => boolean = hasUsableFloatingTerminalPanelViewport
): boolean {
  return viewState?.maximized === true && hasUsableViewport()
}
