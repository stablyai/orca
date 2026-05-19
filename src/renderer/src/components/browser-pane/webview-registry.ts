import { clearLiveBrowserUrl } from './browser-runtime'

// Why: the webview registry is shared coordination state between BrowserPane
// (React component) and store-layer cleanup helpers (shutdownWorktreeBrowsers,
// subscriber diff). Keeping it in its own non-React module breaks the cycle
// store/slices → components → @/store that would otherwise appear if
// destroyPersistentWebview lived in BrowserPane.tsx.
export const webviewRegistry = new Map<string, Electron.WebviewTag>()
export const registeredWebContentsIds = new Map<string, number>()
export const parkedAtByTabId = new Map<string, number>()

export const MAX_PARKED_WEBVIEWS = 6

let hiddenContainer: HTMLDivElement | null = null
const DRAG_LISTENER_KEY = '__orcaBrowserPaneDragListeners'
let dragListenersAttached = false

type DragListenerRegistry = {
  dragstart: () => void
  dragend: () => void
  drop: () => void
}

function getListenerHost(): (Window & { [DRAG_LISTENER_KEY]?: DragListenerRegistry }) | null {
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') {
    return null
  }
  return window as Window & { [DRAG_LISTENER_KEY]?: DragListenerRegistry }
}

function removeDragListeners(): void {
  const listenerHost = getListenerHost()
  const existingListeners = listenerHost?.[DRAG_LISTENER_KEY]
  if (!listenerHost || !existingListeners) {
    return
  }
  window.removeEventListener('dragstart', existingListeners.dragstart, true)
  window.removeEventListener('dragend', existingListeners.dragend, true)
  window.removeEventListener('drop', existingListeners.drop, true)
  delete listenerHost[DRAG_LISTENER_KEY]
  dragListenersAttached = false
}

function ensureDragListeners(): void {
  const listenerHost = getListenerHost()
  if (!listenerHost) {
    return
  }
  if (dragListenersAttached && listenerHost[DRAG_LISTENER_KEY]) {
    return
  }
  removeDragListeners()

  const dragstart = (): void => setWebviewsDragPassthrough(true)
  const dragend = (): void => setWebviewsDragPassthrough(false)
  const drop = (): void => setWebviewsDragPassthrough(false)

  window.addEventListener('dragstart', dragstart, true)
  window.addEventListener('dragend', dragend, true)
  window.addEventListener('drop', drop, true)
  // Why: only live webviews need drag passthrough listeners; removing them
  // when the registry empties keeps browserless sessions free of global hooks.
  listenerHost[DRAG_LISTENER_KEY] = { dragstart, dragend, drop }
  dragListenersAttached = true
}

export function getHiddenContainer(): HTMLDivElement {
  if (!hiddenContainer) {
    hiddenContainer = document.createElement('div')
    hiddenContainer.style.position = 'fixed'
    hiddenContainer.style.left = '-9999px'
    hiddenContainer.style.top = '-9999px'
    hiddenContainer.style.width = '100vw'
    hiddenContainer.style.height = '100vh'
    hiddenContainer.style.overflow = 'hidden'
    hiddenContainer.style.pointerEvents = 'none'
    document.body.appendChild(hiddenContainer)
  }
  return hiddenContainer
}

export function setWebviewsDragPassthrough(passthrough: boolean): void {
  for (const webview of webviewRegistry.values()) {
    webview.style.pointerEvents = passthrough ? 'none' : ''
  }
}

export function registerPersistentWebview(
  browserTabId: string,
  webview: Electron.WebviewTag
): void {
  webviewRegistry.set(browserTabId, webview)
  ensureDragListeners()
}

export function unregisterPersistentWebview(browserTabId: string): void {
  webviewRegistry.delete(browserTabId)
  if (webviewRegistry.size === 0) {
    removeDragListeners()
  }
}

export function destroyPersistentWebview(browserTabId: string): void {
  const webview = webviewRegistry.get(browserTabId)
  if (!webview) {
    registeredWebContentsIds.delete(browserTabId)
    parkedAtByTabId.delete(browserTabId)
    clearLiveBrowserUrl(browserTabId)
    return
  }
  void window.api.browser.unregisterGuest({ browserPageId: browserTabId })
  // Why: if this webview currently owns focus, removing it lets macOS hand
  // activation back to the previously-active app (Slack, etc.) because the
  // focused webContents is gone with no replacement. Move focus back into the
  // main renderer first so Electron keeps focus inside the Orca window.
  if (webview === document.activeElement || webview.contains(document.activeElement)) {
    ;(document.activeElement as HTMLElement | null)?.blur?.()
    window.focus()
  }
  webview.remove()
  unregisterPersistentWebview(browserTabId)
  registeredWebContentsIds.delete(browserTabId)
  parkedAtByTabId.delete(browserTabId)
  clearLiveBrowserUrl(browserTabId)
}
