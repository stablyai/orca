import { invokeNative, isTauriNativeHost, listenNative } from './tauri-native-host'
import { buildTauriBrowserWebviewTag } from './tauri-native-browser-webview-tag'
import type { TauriBrowserPageEvent as BrowserPageEvent } from './tauri-native-browser-events'

type BrowserAnnotationViewportMessage = {
  browserPageId: string
  message: string
}

export type NativeBrowserPage = {
  browserPageId: string
  element: HTMLDivElement
  url: string
  title: string
  loading: boolean
  zoomLevel: number
  history: string[]
  historyIndex: number
  destroyed: boolean
  ready: Promise<void>
}

const nativePages = new Map<string, NativeBrowserPage>()
let pageEventUnsubscribe: (() => void) | null = null

function ensurePageEventListener(): void {
  if (pageEventUnsubscribe || !isTauriNativeHost()) {
    return
  }
  pageEventUnsubscribe = listenNative<BrowserPageEvent>('browser:page-event', dispatchPageEvent)
  listenNative<BrowserAnnotationViewportMessage>('browser:annotation-viewport-message', (event) => {
    const page = nativePages.get(event.browserPageId)
    if (!page || page.destroyed) {
      return
    }
    dispatchElementEvent(page, 'console-message', { message: event.message })
  })
}

function defineEventProperties(event: Event, properties: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(properties)) {
    Object.defineProperty(event, key, {
      configurable: true,
      enumerable: true,
      value
    })
  }
}

function dispatchElementEvent(
  page: NativeBrowserPage,
  eventType: string,
  properties: Record<string, unknown> = {}
): void {
  const event = new Event(eventType)
  defineEventProperties(event, properties)
  page.element.dispatchEvent(event)
}

function dispatchPageEvent(event: BrowserPageEvent): void {
  const page = nativePages.get(event.browserPageId)
  if (!page || page.destroyed) {
    return
  }
  if (event.url) {
    page.url = event.url
  }
  if (event.title !== null && event.title !== undefined) {
    page.title = event.title
  }
  page.loading = event.eventType === 'did-start-loading'
  // Same-document commits extend the history like full ones (back/forward traverse them);
  // load-commit stays full-navigation-only, it paints newly committed documents.
  if (
    (event.eventType === 'did-navigate' || event.eventType === 'did-navigate-in-page') &&
    event.url
  ) {
    const current = page.history[page.historyIndex]
    if (current !== event.url) {
      page.history = [...page.history.slice(0, page.historyIndex + 1), event.url]
      page.historyIndex = page.history.length - 1
    }
    if (event.eventType === 'did-navigate') {
      dispatchElementEvent(page, 'load-commit', {
        url: event.url,
        isMainFrame: event.isMainFrame !== false
      })
    }
  }
  if (event.eventType === 'destroyed') {
    page.destroyed = true
  }
  dispatchElementEvent(page, event.eventType, {
    url: event.url ?? page.url,
    title: event.title ?? page.title,
    isMainFrame: event.isMainFrame ?? true,
    isInPlace: event.isInPlace ?? false,
    errorCode: event.errorCode,
    errorDescription: event.errorDescription,
    validatedURL: event.validatedUrl,
    favicons: event.favicons,
    reason: event.reason,
    exitCode: event.exitCode
  })
}

function pageBounds(element: HTMLElement): { x: number; y: number; width: number; height: number } {
  const rect = element.getBoundingClientRect()
  return {
    x: Math.max(0, rect.left),
    y: Math.max(0, rect.top),
    width: Math.max(1, rect.width),
    height: Math.max(1, rect.height)
  }
}

function invokeBrowserPageCommand<T>(
  page: NativeBrowserPage,
  command: string,
  args: Record<string, unknown>
): Promise<T> {
  return page.ready.then(() => invokeNative<T>(command, { args }))
}

function setNativeBounds(page: NativeBrowserPage): void {
  void invokeBrowserPageCommand(page, 'poc_browser_set_bounds', {
    browserPageId: page.browserPageId,
    bounds: pageBounds(page.element)
  })
}

function queueNavigation(page: NativeBrowserPage, url: string): void {
  page.url = url
  const current = page.history[page.historyIndex]
  if (current !== url) {
    page.history = [...page.history.slice(0, page.historyIndex + 1), url]
    page.historyIndex = page.history.length - 1
  }
  void invokeBrowserPageCommand(page, 'poc_browser_navigate', {
    browserPageId: page.browserPageId,
    url
  })
}

function closeNativePage(page: NativeBrowserPage): void {
  if (page.destroyed) {
    return
  }
  page.destroyed = true
  void invokeBrowserPageCommand(page, 'poc_browser_close', {
    browserPageId: page.browserPageId
  })
    .then(() => dispatchElementEvent(page, 'destroyed'))
    .catch(() => {})
  nativePages.delete(page.browserPageId)
}

export function hasTauriNativeBrowserPage(browserPageId: string): boolean {
  return nativePages.has(browserPageId)
}
export function getTauriNativeBrowserPageInfo(
  browserPageId: string
): { url: string; title: string } | null {
  const page = nativePages.get(browserPageId)
  return page && !page.destroyed ? { url: page.url, title: page.title } : null
}

export function removeTauriNativeBrowserPage(browserPageId: string): void {
  const page = nativePages.get(browserPageId)
  if (!page) {
    return
  }
  closeNativePage(page)
  page.element.remove()
}

export function syncTauriNativeBrowserWebviewBounds(browserPageId: string): void {
  const page = nativePages.get(browserPageId)
  if (page && !page.destroyed) {
    setNativeBounds(page)
  }
}

export function setTauriNativeBrowserWebviewVisible(browserPageId: string, visible: boolean): void {
  const page = nativePages.get(browserPageId)
  if (!page || page.destroyed) {
    return
  }
  setNativeBounds(page)
  void invokeBrowserPageCommand(page, 'poc_browser_set_visible', { browserPageId, visible }).catch(
    () => {}
  )
}

export function createTauriNativeBrowserWebview({
  browserPageId,
  container,
  partition,
  visible,
  appendToContainer = true
}: {
  browserPageId: string
  container?: HTMLDivElement
  partition: string
  visible: boolean
  appendToContainer?: boolean
}): Electron.WebviewTag {
  ensurePageEventListener()
  const element = document.createElement('div')
  const removeElement = element.remove.bind(element)
  element.dataset.tauriBrowserPageId = browserPageId
  element.setAttribute('partition', partition)
  element.style.position = 'absolute'
  element.style.inset = '0'
  element.style.width = '100%'
  element.style.height = '100%'
  element.style.border = 'none'
  element.style.background = 'var(--background)'
  element.style.visibility = 'hidden'
  element.setAttribute('aria-hidden', 'true')

  const page: NativeBrowserPage = {
    browserPageId,
    element,
    url: 'about:blank',
    title: '',
    loading: false,
    zoomLevel: 0,
    history: ['about:blank'],
    historyIndex: 0,
    destroyed: false,
    ready: Promise.resolve()
  }
  nativePages.set(browserPageId, page)
  if (appendToContainer && container) {
    container.appendChild(element)
  }
  page.ready = invokeNative<{ url: string }>('poc_browser_create', {
    args: {
      browserPageId,
      partition,
      bounds: pageBounds(element),
      visible
    }
  })
    .then((state) => {
      page.url = state.url || page.url
      page.history = [page.url]
      page.historyIndex = 0
      dispatchElementEvent(page, 'did-attach')
    })
    .catch((error: unknown) => {
      nativePages.delete(browserPageId)
      dispatchElementEvent(page, 'did-fail-load', {
        errorCode: -1,
        errorDescription: error instanceof Error ? error.message : 'Tauri browser creation failed',
        validatedURL: page.url,
        isMainFrame: true
      })
    })

  setNativeBounds(page)
  return buildTauriBrowserWebviewTag(page, {
    queueNavigation,
    invokeCommand: invokeBrowserPageCommand,
    closePage: closeNativePage,
    detachElement: removeElement
  })
}
