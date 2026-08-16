import { ORCA_BROWSER_GUEST_WEB_PREFERENCES_ATTRIBUTE } from '../../../../shared/browser-guest-web-preferences'

export function createBrowserClientPageRetainedRoot(document: Document): HTMLDivElement {
  const root = document.createElement('div')
  root.dataset.browserClientPageRetainedRoot = ''
  root.inert = true
  root.setAttribute('aria-hidden', 'true')
  Object.assign(root.style, {
    position: 'fixed',
    left: '-10000px',
    top: '0',
    width: '1px',
    height: '1px',
    overflow: 'hidden',
    opacity: '0',
    pointerEvents: 'none'
  })
  document.body.appendChild(root)
  return root
}

export function createBrowserClientPageRetainedHost(document: Document): HTMLDivElement {
  const host = document.createElement('div')
  host.inert = true
  host.setAttribute('aria-hidden', 'true')
  Object.assign(host.style, {
    position: 'absolute',
    inset: '0',
    width: '1px',
    height: '1px',
    overflow: 'hidden',
    pointerEvents: 'none'
  })
  return host
}

export function createBrowserClientPageWebview(options: {
  createWebview?: () => Electron.WebviewTag
  document: Document
  partition: string
}): Electron.WebviewTag {
  const webview =
    options.createWebview?.() ?? (options.document.createElement('webview') as Electron.WebviewTag)
  webview.setAttribute('partition', options.partition)
  webview.setAttribute('webpreferences', ORCA_BROWSER_GUEST_WEB_PREFERENCES_ATTRIBUTE)
  webview.setAttribute('src', 'about:blank')
  Object.assign(webview.style, { display: 'flex', width: '100%', height: '100%' })
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
