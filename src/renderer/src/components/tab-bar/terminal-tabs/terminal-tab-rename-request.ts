/** Address rename events to one tab; store-state requests would rerender every tab both when armed and when cleared. */
export const RENAME_TERMINAL_TAB_EVENT = 'orca-rename-terminal-tab'

export type RenameTerminalTabDetail = {
  tabId: string
}

// Rename requests are synchronous events, so callers outside the tab bar must know a listener exists.
const mountedRenameListeners = new Map<string, number>()

export function registerTerminalTabRenameListener(tabId: string): () => void {
  mountedRenameListeners.set(tabId, (mountedRenameListeners.get(tabId) ?? 0) + 1)
  return () => {
    const count = (mountedRenameListeners.get(tabId) ?? 0) - 1
    if (count > 0) {
      mountedRenameListeners.set(tabId, count)
    } else {
      mountedRenameListeners.delete(tabId)
    }
  }
}

export function hasTerminalTabRenameListener(tabId: string): boolean {
  return mountedRenameListeners.has(tabId)
}

export function requestTerminalTabRename(tabId: string): void {
  window.dispatchEvent(
    new CustomEvent<RenameTerminalTabDetail>(RENAME_TERMINAL_TAB_EVENT, { detail: { tabId } })
  )
}
