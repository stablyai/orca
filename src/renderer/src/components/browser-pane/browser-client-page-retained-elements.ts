import { ORCA_BROWSER_PAGE_GUEST_WEB_PREFERENCES_ATTRIBUTE } from '../../../../shared/browser-guest-web-preferences'
import { isBlankBrowserUrl } from '@/lib/browser-palette-search'

export function createBrowserClientPageRetainedRoot(document: Document): HTMLDivElement {
  const root = document.createElement('div')
  root.dataset.browserClientPageRetainedRoot = ''
  root.style.display = 'contents'
  document.body.appendChild(root)
  return root
}

/** The fixed host lives outside its pane, so stamp the stable page ID; DOM containment and rekeyed generations cannot identify its row. */
export function createBrowserClientPageRetainedHost(
  document: Document,
  browserPageId: string
): HTMLDivElement {
  const host = document.createElement('div')
  host.dataset.browserClientPageId = browserPageId
  host.inert = true
  host.setAttribute('aria-hidden', 'true')
  Object.assign(host.style, {
    position: 'fixed',
    left: '-10000px',
    top: '0',
    width: '1px',
    height: '1px',
    overflow: 'hidden',
    pointerEvents: 'none'
  })
  return host
}

/** Hide host paint and hit testing on blank guests so the New Tab page beneath remains usable. */
export function hideRetainedHostWhileGuestIsBlank(
  host: HTMLDivElement
): (event: Electron.LoadCommitEvent) => void {
  return (event) => {
    if (event.isMainFrame) {
      host.style.visibility = isBlankBrowserUrl(event.url) ? 'hidden' : ''
    }
  }
}

type BrowserClientPageGuestMessageHandler = (
  browserPageId: string,
  webview: Electron.WebviewTag,
  event: Electron.IpcMessageEvent
) => void

let guestMessageHandler: BrowserClientPageGuestMessageHandler | null = null

// Why injected: this module also runs in a bare Electron fixture that cannot load the app store.
export function registerBrowserClientPageGuestMessageHandler(
  handler: BrowserClientPageGuestMessageHandler | null
): void {
  guestMessageHandler = handler
}

export function createBrowserClientPageWebview(options: {
  createWebview?: () => Electron.WebviewTag
  document: Document
  identity: { browserPageId: string; partition: string }
}): Electron.WebviewTag {
  const webview =
    options.createWebview?.() ?? (options.document.createElement('webview') as Electron.WebviewTag)
  webview.setAttribute('partition', options.identity.partition)
  webview.setAttribute('webpreferences', ORCA_BROWSER_PAGE_GUEST_WEB_PREFERENCES_ATTRIBUTE)
  webview.setAttribute('src', 'about:blank')
  Object.assign(webview.style, { display: 'flex', width: '100%', height: '100%' })
  webview.addEventListener('ipc-message', (event) =>
    guestMessageHandler?.(options.identity.browserPageId, webview, event)
  )
  return webview
}

export function readBrowserClientPageAttachedGuestId(webview: Electron.WebviewTag): number | null {
  try {
    const webContentsId = webview.getWebContentsId()
    return Number.isInteger(webContentsId) && webContentsId > 0 ? webContentsId : null
  } catch {
    return null
  }
}

export function hasBrowserClientPageAttachedGuest(webview: Electron.WebviewTag): boolean {
  return readBrowserClientPageAttachedGuestId(webview) !== null
}
