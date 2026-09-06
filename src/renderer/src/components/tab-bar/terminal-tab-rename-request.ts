/**
 * Targeted rename dispatch for the `tab.rename` shortcut.
 *
 * Why an event and not store state: a store field is read by every mounted tab, so arming it
 * re-rendered the whole strip, and the consuming tab then had to clear it — a second pass over
 * every tab. The event reaches only the tab that owns the id. Mirrors the terminal-pane
 * TOGGLE_TERMINAL_PANE_EXPAND_EVENT / FOCUS_TERMINAL_PANE_EVENT dispatch.
 */
export const RENAME_TERMINAL_TAB_EVENT = 'orca-rename-terminal-tab'

export type RenameTerminalTabDetail = {
  tabId: string
}

export function requestTerminalTabRename(tabId: string): void {
  window.dispatchEvent(
    new CustomEvent<RenameTerminalTabDetail>(RENAME_TERMINAL_TAB_EVENT, { detail: { tabId } })
  )
}
