import type {
  BrowserClientPageRendererOutcome,
  BrowserClientPageRendererRequest
} from '../../../../shared/browser-client-page-renderer-protocol'
import {
  BrowserClientPageRetainedRegistry,
  type BrowserClientPageRendererMemoryProfile,
  type BrowserClientPageVisibleAttachment
} from './browser-client-page-retained-registry'

type RendererPageRegistry = {
  attachPage?(
    page: Pick<BrowserClientPageRendererRequest['page'], 'browserPageId' | 'pageHostGeneration'>,
    container: HTMLElement
  ): BrowserClientPageVisibleAttachment
  dispose(): void
  getMemoryProfile(): BrowserClientPageRendererMemoryProfile
  mountPage(page: BrowserClientPageRendererRequest['page']): Promise<{ webContentsId: number }>
  rekeyPage(
    previous: BrowserClientPageRendererRequest['page'],
    next: BrowserClientPageRendererRequest['page']
  ): void
  retirePage(page: BrowserClientPageRendererRequest['page']): void
}

let activeRendererPageRegistry: RendererPageRegistry | null = null

export function attachBrowserClientPageToViewport(
  page: Pick<BrowserClientPageRendererRequest['page'], 'browserPageId' | 'pageHostGeneration'>,
  container: HTMLElement
): BrowserClientPageVisibleAttachment | null {
  return activeRendererPageRegistry?.attachPage?.(page, container) ?? null
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
    new BrowserClientPageRetainedRegistry({ document: options.document ?? document })
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
