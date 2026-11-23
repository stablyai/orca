import type { BrowserGuestIdleDiscardToken } from '../../../../../../shared/browser/guest-lifecycle/browser-guest-discard-protection'
import type {
  BrowserClientPageRendererOutcome,
  BrowserClientPageRendererRequest
} from '../../../../../../shared/browser/client-hosting/browser-client-page-renderer-protocol'
import { BrowserClientPageRetainedRegistry } from './browser-client-page-retained-registry'
import type { BrowserClientPageRendererMemoryProfile } from './browser-client-page-retained-memory-profile'
import type { BrowserClientPageVisibleAttachment } from './browser-client-page-visible-attachment'
import {
  markBrowserClientPageFreed,
  noteBrowserClientPageMounted
} from './browser-client-page-freed-pages'

type PageKey = Pick<
  BrowserClientPageRendererRequest['page'],
  'browserPageId' | 'pageHostGeneration'
>

type RendererPageRegistry = {
  attachPage?(
    page: Pick<BrowserClientPageRendererRequest['page'], 'browserPageId' | 'pageHostGeneration'>,
    container: HTMLElement
  ): BrowserClientPageVisibleAttachment
  dispose(): void
  findAttachedWebview?(browserPageId: string): Electron.WebviewTag | null
  hasAttachedPage?(page: PageKey): boolean
  getMemoryProfile(): BrowserClientPageRendererMemoryProfile
  mountPage(page: BrowserClientPageRendererRequest['page']): Promise<{ webContentsId: number }>
  rekeyPage(
    previous: BrowserClientPageRendererRequest['page'],
    next: BrowserClientPageRendererRequest['page']
  ): void
  retirePage(page: BrowserClientPageRendererRequest['page']): void
}

let activeRendererPageRegistry: RendererPageRegistry | null = null
const mountedListeners = new Set<(page: PageKey) => void>()

export function attachBrowserClientPageToViewport(
  page: Pick<BrowserClientPageRendererRequest['page'], 'browserPageId' | 'pageHostGeneration'>,
  container: HTMLElement
): BrowserClientPageVisibleAttachment | null {
  return activeRendererPageRegistry?.attachPage?.(page, container) ?? null
}

/** The retained guest of a This-device page; these never enter the pane webview registry. */
export function findBrowserClientPageWebview(browserPageId: string): Electron.WebviewTag | null {
  return activeRendererPageRegistry?.findAttachedWebview?.(browserPageId) ?? null
}

/** Hands a hidden This-device page to main, which retires its guest while the server keeps it. */
export function freeBrowserClientPage(
  browserPageId: string,
  webview: Electron.WebviewTag,
  webContentsId: number,
  policyToken: BrowserGuestIdleDiscardToken
): boolean {
  const freed =
    findBrowserClientPageWebview(browserPageId) === webview &&
    window.api.browser.reserveGuestDiscard({ browserPageId, webContentsId, policyToken })
  if (freed) {
    markBrowserClientPageFreed(browserPageId)
  }
  return freed
}

/** Asks main to remake a page Memory Saver freed and calls back once that guest is mounted again. */
export function wakeBrowserClientPage(
  page: PageKey,
  onMounted: () => void,
  onUnavailable: () => void
): () => void {
  let active = true
  const stop = (): void => {
    active = false
    mountedListeners.delete(listener)
  }
  const listener = (mounted: PageKey): void => {
    if (
      active &&
      mounted.browserPageId === page.browserPageId &&
      mounted.pageHostGeneration === page.pageHostGeneration
    ) {
      stop()
      onMounted()
    }
  }
  mountedListeners.add(listener)
  void (
    window.api?.browser.wakeClientPage?.({ browserPageId: page.browserPageId }) ??
    Promise.resolve(false)
  )
    .catch(() => false)
    .then((woken) => {
      if (!active || woken) {
        return
      }
      // An agent command may have remade it before the pane looked; a later mount still attaches.
      if (activeRendererPageRegistry?.hasAttachedPage?.(page)) {
        stop()
        onMounted()
      } else {
        onUnavailable()
      }
    })
  return stop
}

type RendererRequestSubscriber = (
  callback: (
    request: BrowserClientPageRendererRequest
  ) => BrowserClientPageRendererOutcome | Promise<BrowserClientPageRendererOutcome>
) => () => void

export type BrowserClientPageRendererInstallation = {
  dispose(): void
  getMemoryProfile(): BrowserClientPageRendererMemoryProfile
}

export function installBrowserClientPageRenderer(
  options: {
    document?: Document
    registry?: RendererPageRegistry
    subscribe?: RendererRequestSubscriber
  } = {}
): BrowserClientPageRendererInstallation | null {
  if (
    typeof window !== 'undefined' &&
    (window as unknown as { __ORCA_WEB_CLIENT__?: boolean }).__ORCA_WEB_CLIENT__ === true
  ) {
    return null
  }
  const subscribe =
    options.subscribe ??
    (typeof window === 'undefined'
      ? undefined
      : (window as unknown as { api?: Window['api'] }).api?.browser.onClientPageRendererRequest)
  if (typeof subscribe !== 'function') {
    return null
  }
  const registry =
    options.registry ??
    new BrowserClientPageRetainedRegistry({
      document: options.document ?? document,
      onPageMounted: (page) => {
        noteBrowserClientPageMounted(page.browserPageId)
        for (const listener of mountedListeners) {
          listener(page)
        }
      }
    })
  const unsubscribe = subscribe((request) => handleRequest(registry, request))
  activeRendererPageRegistry = registry
  let disposed = false
  return {
    dispose: () => {
      if (disposed) {
        return
      }
      disposed = true
      unsubscribe()
      if (activeRendererPageRegistry === registry) {
        activeRendererPageRegistry = null
      }
      registry.dispose()
    },
    getMemoryProfile: () => registry.getMemoryProfile()
  }
}

async function handleRequest(
  registry: RendererPageRegistry,
  request: BrowserClientPageRendererRequest
): Promise<BrowserClientPageRendererOutcome> {
  try {
    if (request.type === 'mountPage') {
      const mounted = await registry.mountPage(request.page)
      return { type: 'mounted', webContentsId: mounted.webContentsId }
    }
    if (request.type === 'rekeyPage') {
      registry.rekeyPage(request.page, request.nextPage)
      return { type: 'rekeyed' }
    }
    registry.retirePage(request.page)
    return { type: 'retired' }
  } catch (error) {
    return { type: 'failed', errorCode: rendererErrorCode(error) }
  }
}

function rendererErrorCode(error: unknown): string {
  return error instanceof Error && /^browser_client_page_renderer_[a-z_]+$/.test(error.message)
    ? error.message
    : 'browser_client_page_renderer_operation_failed'
}
