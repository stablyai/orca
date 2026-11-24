import { clearPersistedFloatingTerminalPanelBounds } from './floating-terminal-panel-bounds'
import { persistFloatingTerminalPanelMaximized } from '../state/floating-terminal-panel-view-state'

export const RESET_FLOATING_TERMINAL_PANEL_LAYOUT_EVENT =
  'orca-reset-floating-terminal-panel-layout'

/** Drop the saved rect so the next mount uses the default layout, and tell a mounted panel to adopt it now. */
export function resetFloatingTerminalPanelLayout(): void {
  clearPersistedFloatingTerminalPanelBounds()
  persistFloatingTerminalPanelMaximized(false)
  window.dispatchEvent(new Event(RESET_FLOATING_TERMINAL_PANEL_LAYOUT_EVENT))
}
