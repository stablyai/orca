import {
  REQUEST_ACTIVE_TERMINAL_PANE_CLOSE_EVENT,
  type RequestActiveTerminalPaneCloseDetail
} from '@/constants/terminal'

/** Asks the mounted pane of `tabId` to close its active split, with the usual running-process confirmation. */
export function requestActiveTerminalPaneClose(tabId: string, leafId?: string): boolean {
  return !window.dispatchEvent(
    new CustomEvent<RequestActiveTerminalPaneCloseDetail>(
      REQUEST_ACTIVE_TERMINAL_PANE_CLOSE_EVENT,
      { detail: { tabId, ...(leafId ? { leafId } : {}) }, cancelable: true }
    )
  )
}

/** The mounted pane's side of `requestActiveTerminalPaneClose`. Returns the unsubscribe. */
export function onActiveTerminalPaneCloseRequest(
  tabId: string,
  closeActivePane: (leafId?: string) => void
): () => void {
  const onRequest = (event: Event): void => {
    if (event instanceof CustomEvent && isCloseRequestFor(event.detail, tabId)) {
      event.preventDefault()
      closeActivePane((event.detail as RequestActiveTerminalPaneCloseDetail).leafId)
    }
  }
  window.addEventListener(REQUEST_ACTIVE_TERMINAL_PANE_CLOSE_EVENT, onRequest)
  return () => window.removeEventListener(REQUEST_ACTIVE_TERMINAL_PANE_CLOSE_EVENT, onRequest)
}

function isCloseRequestFor(detail: unknown, tabId: string): boolean {
  return (
    typeof detail === 'object' && detail !== null && 'tabId' in detail && detail.tabId === tabId
  )
}
