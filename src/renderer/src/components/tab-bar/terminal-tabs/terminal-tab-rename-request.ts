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

// Why: a launched chat can become active before its title editor mounts, and the old five-second
// observer silently expired while a remote workspace was still opening.
const pendingRenameTabIds = new Set<string>()

/** Starts rename only after a newly launched tab has mounted. */
export function requestTerminalTabRenameWhenMounted(tabId: string): void {
  if (typeof document === 'undefined' || typeof window === 'undefined' || !document.body) {
    return
  }
  if (isRenameTargetMounted(tabId)) {
    window.requestAnimationFrame(() => requestTerminalTabRename(tabId))
    return
  }
  pendingRenameTabIds.add(tabId)
}

/** Lets the tab's title editor finish a rename request queued before that editor mounted. */
export function consumePendingTerminalTabRename(tabId: string): boolean {
  return pendingRenameTabIds.delete(tabId)
}

function isRenameTargetMounted(tabId: string): boolean {
  return (
    Array.from(document.querySelectorAll<HTMLElement>('[data-tab-id]')).some(
      (element) => element.dataset.tabId === tabId
    ) ||
    Array.from(document.querySelectorAll<HTMLElement>('[data-chat-panel-active-tab-id]')).some(
      (element) => element.dataset.chatPanelActiveTabId === tabId
    )
  )
}
