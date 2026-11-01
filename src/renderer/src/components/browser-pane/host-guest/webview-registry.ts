import { clearLiveBrowserUrl } from '../describe-page/live-browser-url-registry'
import {
  clearBrowserPageViewportPresetSize,
  removeBrowserPageViewport
} from './browser-page-viewport'
import {
  acquireWebviewsDragPassthrough,
  isWebviewDragPassthroughActive,
  registerWebviewDragPassthroughSurface
} from './webview-drag-passthrough'

export { acquireWebviewsDragPassthrough } from './webview-drag-passthrough'

// Keep guest coordination outside React to break the store/slices → components → store cleanup cycle.
export const webviewRegistry = new Map<string, Electron.WebviewTag>()
export const registeredWebContentsIds = new Map<string, number>()

export type BrowserWebviewMemoryProfile = {
  browserWebviewCount: number
  registeredBrowserGuestCount: number
}

const DRAG_LISTENER_KEY = '__orcaBrowserPaneDragListeners'
let dragListenersAttached = false
let nativeDragPassthroughRelease: (() => void) | null = null
const dragPassthroughPreviousPointerEvents = new Map<Electron.WebviewTag, string>()
const rendererRecoveryPendingPageIds = new Set<string>()
const webviewLifecycleListeners = new Map<
  string,
  {
    webview: Electron.WebviewTag
    onRendererGone: EventListener
    onRendererReady: EventListener
    onGuestDestroyed: EventListener
  }
>()

type DragListenerRegistry = {
  dragstart: () => void
  dragend: () => void
  drop: () => void
  pointerdown: () => void
  pointermove: () => void
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
  window.removeEventListener('pointerdown', existingListeners.pointerdown, true)
  window.removeEventListener('pointermove', existingListeners.pointermove, true)
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
  // Cancelled dragstart emits no dragend/drop; a pointer event proves the native drag is over and releases passthrough.
  const pointerdown = (): void => setWebviewsDragPassthrough(false)
  const pointermove = (): void => setWebviewsDragPassthrough(false)

  window.addEventListener('dragstart', dragstart, true)
  window.addEventListener('dragend', dragend, true)
  window.addEventListener('drop', drop, true)
  window.addEventListener('pointerdown', pointerdown, true)
  window.addEventListener('pointermove', pointermove, true)
  // Attach global drag listeners only while guests exist.
  listenerHost[DRAG_LISTENER_KEY] = { dragstart, dragend, drop, pointerdown, pointermove }
  dragListenersAttached = true
}

export function hasLiveBrowserGuest(browserPageId: string): boolean {
  return webviewRegistry.has(browserPageId)
}

export function getBrowserWebviewMemoryProfile(): BrowserWebviewMemoryProfile {
  return {
    browserWebviewCount: webviewRegistry.size,
    registeredBrowserGuestCount: registeredWebContentsIds.size
  }
}

function applyWebviewsDragPassthrough(passthrough: boolean): void {
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

registerWebviewDragPassthroughSurface(applyWebviewsDragPassthrough)

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
  if (!isWebviewDragPassthroughActive()) {
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
  const previousListeners = webviewLifecycleListeners.get(browserTabId)
  if (previousListeners) {
    previousListeners.webview.removeEventListener(
      'render-process-gone',
      previousListeners.onRendererGone
    )
    previousListeners.webview.removeEventListener('dom-ready', previousListeners.onRendererReady)
    previousListeners.webview.removeEventListener('destroyed', previousListeners.onGuestDestroyed)
  }
  const onRendererGone = (): void => {
    rendererRecoveryPendingPageIds.add(browserTabId)
  }
  const onRendererReady = (): void => {
    rendererRecoveryPendingPageIds.delete(browserTabId)
  }
  const onGuestDestroyed = (): void => {
    // Intentional removal also emits destroyed; only attached guests need recovery.
    if (webview.isConnected) {
      rendererRecoveryPendingPageIds.add(browserTabId)
    }
  }
  webview.addEventListener('render-process-gone', onRendererGone)
  webview.addEventListener('dom-ready', onRendererReady)
  webview.addEventListener('destroyed', onGuestDestroyed)
  webviewLifecycleListeners.set(browserTabId, {
    webview,
    onRendererGone,
    onRendererReady,
    onGuestDestroyed
  })
  webviewRegistry.set(browserTabId, webview)
  applyCurrentDragPassthroughToWebview(webview)
  ensureDragListeners()
}

export function unregisterPersistentWebview(browserTabId: string): void {
  const webview = webviewRegistry.get(browserTabId)
  const lifecycleListeners = webviewLifecycleListeners.get(browserTabId)
  if (lifecycleListeners) {
    lifecycleListeners.webview.removeEventListener(
      'render-process-gone',
      lifecycleListeners.onRendererGone
    )
    lifecycleListeners.webview.removeEventListener('dom-ready', lifecycleListeners.onRendererReady)
    lifecycleListeners.webview.removeEventListener('destroyed', lifecycleListeners.onGuestDestroyed)
    webviewLifecycleListeners.delete(browserTabId)
  }
  rendererRecoveryPendingPageIds.delete(browserTabId)
  if (webview) {
    dragPassthroughPreviousPointerEvents.delete(webview)
  }
  webviewRegistry.delete(browserTabId)
  if (webviewRegistry.size === 0) {
    removeDragListeners()
  }
}

export function isBrowserPageRendererRecoveryPending(browserTabId: string): boolean {
  return rendererRecoveryPendingPageIds.has(browserTabId)
}

function moveFocusToRendererIfWebviewOwnsFocus(webview: Electron.WebviewTag): boolean {
  if (typeof document === 'undefined' || typeof window === 'undefined') {
    return false
  }
  const activeElement = document.activeElement as HTMLElement | null
  if (!activeElement) {
    return false
  }
  // Blur before hiding/removal so macOS cannot reactivate the previously frontmost app.
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

function removePersistentWebview(
  browserTabId: string,
  { preserveViewport }: { preserveViewport: boolean }
): Promise<void> {
  const webview = webviewRegistry.get(browserTabId)
  if (!webview) {
    // A viewport can outlive its registry entry; explicit close must remove the parked shell too.
    if (!preserveViewport) {
      clearBrowserPageViewportPresetSize(browserTabId)
      removeBrowserPageViewport(browserTabId)
    }
    registeredWebContentsIds.delete(browserTabId)
    clearLiveBrowserUrl(browserTabId)
    return Promise.resolve()
  }
  const unregisterGuest = Promise.resolve(
    window.api.browser.unregisterGuest({ browserPageId: browserTabId })
  ).catch(() => {})
  moveFocusToRendererBeforeWebviewDetach(webview)
  webview.remove()
  unregisterPersistentWebview(browserTabId)
  if (!preserveViewport) {
    clearBrowserPageViewportPresetSize(browserTabId)
    removeBrowserPageViewport(browserTabId)
  }
  registeredWebContentsIds.delete(browserTabId)
  clearLiveBrowserUrl(browserTabId)
  return unregisterGuest
}

export function destroyPersistentWebview(browserTabId: string): Promise<void> {
  return removePersistentWebview(browserTabId, { preserveViewport: false })
}

export function replacePersistentWebview(
  browserTabId: string,
  { preserveViewport = false }: { preserveViewport?: boolean } = {}
): Promise<void> {
  return removePersistentWebview(browserTabId, { preserveViewport })
}
