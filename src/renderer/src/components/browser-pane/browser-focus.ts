export type BrowserFocusTarget = 'webview' | 'address-bar'

export type BrowserFocusRequestDetail = {
  pageId: string
  target: BrowserFocusTarget
}

export const ORCA_BROWSER_FOCUS_REQUEST_EVENT = 'orca:browser-focus-request'

const pendingBrowserFocusByPageId = new Map<string, BrowserFocusTarget>()

export function queueBrowserFocusRequest(detail: BrowserFocusRequestDetail): void {
  pendingBrowserFocusByPageId.set(detail.pageId, detail.target)
}

export function consumeBrowserFocusRequest(pageId: string): BrowserFocusTarget | null {
  const pending = pendingBrowserFocusByPageId.get(pageId) ?? null
  if (!pending) {
    return null
  }
  pendingBrowserFocusByPageId.delete(pageId)
  return pending
}
