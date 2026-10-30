/** Address rename events to one tab; store-state requests would rerender every tab both when armed and when cleared. */
export const RENAME_TERMINAL_TAB_EVENT = 'orca-rename-terminal-tab'

export type RenameTerminalTabDetail = {
  tabId: string
}

export function requestTerminalTabRename(tabId: string): void {
  window.dispatchEvent(
    new CustomEvent<RenameTerminalTabDetail>(RENAME_TERMINAL_TAB_EVENT, { detail: { tabId } })
  )
}
