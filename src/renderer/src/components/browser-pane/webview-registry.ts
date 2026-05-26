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
let nativeDragPassthroughRelease: (() => void) | null = null
const dragPassthroughTokens = new Set<symbol>()
const dragPassthroughPreviousPointerEvents = new Map<Electron.WebviewTag, string>()

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
  nativeDragPassthroughRelease?.()
  nativeDragPassthroughRelease = null
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

function applyWebviewsDragPassthrough(): void {
  const passthrough = dragPassthroughTokens.size > 0
  for (const webview of webviewRegistry.values()) {
    if (passthrough) {
      if (!dragPassthroughPreviousPointerEvents.has(webview)) {
        dragPassthroughPreviousPointerEvents.set(webview, webview.style.pointerEvents)
      }
      webview.style.pointerEvents = 'none'
      continue
    }

    const previous = dragPassthroughPreviousPointerEvents.get(webview)
    if (previous !== undefined) {
      webview.style.pointerEvents = previous
      dragPassthroughPreviousPointerEvents.delete(webview)
    }
  }
}

export function acquireWebviewsDragPassthrough(): () => void {
  // Why: renderer-owned pointer drags (dnd-kit tab drags, terminal pane
  // reorders) do not emit HTML dragstart/dragend, but Electron webviews can
  // still steal the pointer stream unless they are temporarily transparent.
  const token = Symbol('webview-drag-passthrough')
  let released = false
  dragPassthroughTokens.add(token)
  applyWebviewsDragPassthrough()

  return () => {
    if (released) {
      return
    }
    released = true
    dragPassthroughTokens.delete(token)
    applyWebviewsDragPassthrough()
  }
}

export function setWebviewsDragPassthrough(passthrough: boolean): void {
  if (passthrough) {
    if (!nativeDragPassthroughRelease) {
      nativeDragPassthroughRelease = acquireWebviewsDragPassthrough()
    }
    return
  }

  nativeDragPassthroughRelease?.()
  nativeDragPassthroughRelease = null
}

function applyCurrentDragPassthroughToWebview(webview: Electron.WebviewTag): void {
  if (dragPassthroughTokens.size === 0) {
    return
  }
  if (!dragPassthroughPreviousPointerEvents.has(webview)) {
    dragPassthroughPreviousPointerEvents.set(webview, webview.style.pointerEvents)
  }
  webview.style.pointerEvents = 'none'
}

export function registerPersistentWebview(
  browserTabId: string,
  webview: Electron.WebviewTag
): void {
  webviewRegistry.set(browserTabId, webview)
  applyCurrentDragPassthroughToWebview(webview)
  ensureDragListeners()
}

export function unregisterPersistentWebview(browserTabId: string): void {
  const webview = webviewRegistry.get(browserTabId)
  if (webview) {
    dragPassthroughPreviousPointerEvents.delete(webview)
  }
  webviewRegistry.delete(browserTabId)
  if (webviewRegistry.size === 0) {
    removeDragListeners()
  }
}

function moveFocusToRendererIfWebviewOwnsFocus(webview: Electron.WebviewTag): boolean {
  if (typeof document === 'undefined' || typeof window === 'undefined') {
    return false
  }
  const activeElement = document.activeElement as HTMLElement | null
  if (!activeElement) {
    return false
  }
  // Why: hiding/removing a focused webview can let macOS reactivate the
  // previously-frontmost app. Give focus back to Orca's renderer first.
  if (webview === activeElement || webview.contains(activeElement)) {
    activeElement.blur?.()
    window.focus()
    return true
  }
  return false
}

export function moveFocusToRendererBeforeFocusedWebviewHidden(): void {
  for (const webview of webviewRegistry.values()) {
    if (moveFocusToRendererIfWebviewOwnsFocus(webview)) {
      return
    }
  }
}

export function moveFocusToRendererBeforeWebviewDetach(webview: Electron.WebviewTag): void {
  moveFocusToRendererIfWebviewOwnsFocus(webview)
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
  moveFocusToRendererBeforeWebviewDetach(webview)
  webview.remove()
  unregisterPersistentWebview(browserTabId)
  registeredWebContentsIds.delete(browserTabId)
  parkedAtByTabId.delete(browserTabId)
  clearLiveBrowserUrl(browserTabId)
}
