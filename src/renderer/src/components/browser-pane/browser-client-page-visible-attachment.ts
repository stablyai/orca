import { registerWebviewDragPassthroughSurface } from './host-guest/webview-drag-passthrough'
import { registerBrowserClientPagePositionSync } from './browser-client-page-position-driver'
import { syncBrowserClientPagePaintRetention } from './browser-client-page-paint-retention'
import type { BrowserClientPageRendererIdentity as RendererPageIdentity } from '../../../../shared/browser-client-page-renderer-protocol'
import type { BrowserClientRetainedRendererPage as RetainedPage } from './browser-client-page-retained-state'

export type BrowserClientPageVisibleAttachment = {
  webview: Electron.WebviewTag
  nextMetadataRevision(): number
  detach(): void
}

export function findBrowserClientRetainedPageForAttachment(
  pages: Map<string, RetainedPage>,
  identity: Pick<RendererPageIdentity, 'browserPageId' | 'pageHostGeneration'>
): RetainedPage | undefined {
  for (const page of pages.values()) {
    if (
      page.identity.browserPageId === identity.browserPageId &&
      page.identity.pageHostGeneration === identity.pageHostGeneration
    ) {
      return page
    }
  }
  return undefined
}

export function attachBrowserClientRetainedPage(
  page: RetainedPage | undefined,
  pages: Map<string, RetainedPage>,
  container: HTMLElement
): BrowserClientPageVisibleAttachment {
  if (!page || page.status !== 'attached') {
    throw new Error('browser_client_page_renderer_visible_page_unavailable')
  }
  if (page.visibleAttachment) {
    throw new Error('browser_client_page_renderer_visible_page_claimed')
  }
  if (!page.host.parentElement) {
    throw new Error('browser_client_page_renderer_retained_host_unavailable')
  }
  const attachment = { container, stopTrackingViewport: () => {} }
  page.visibleAttachment = attachment
  attachment.stopTrackingViewport = showRetainedHost(page, container)
  let detached = false
  return {
    webview: page.webview,
    nextMetadataRevision: () => {
      if (
        detached ||
        pages.get(page.key) !== page ||
        page.status !== 'attached' ||
        page.visibleAttachment !== attachment
      ) {
        throw new Error('browser_client_page_renderer_visible_page_detached')
      }
      if (page.metadataRevision >= Number.MAX_SAFE_INTEGER) {
        throw new Error('browser_client_page_metadata_revision_exhausted')
      }
      page.metadataRevision += 1
      return page.metadataRevision
    },
    detach: () => {
      if (detached) {
        return
      }
      detached = true
      attachment.stopTrackingViewport()
      if (
        pages.get(page.key) === page &&
        page.status === 'attached' &&
        page.visibleAttachment === attachment
      ) {
        page.visibleAttachment = null
        syncBrowserClientPagePaintRetention(page)
      }
    }
  }
}

/** Register the body-level host for drag passthrough; hidden creation and derived show state also cover enrollment mid-drag. */
export function enrolRetainedHostDragPassthrough(page: RetainedPage): () => void {
  return registerWebviewDragPassthroughSurface(() => syncBrowserClientPagePaintRetention(page))
}

function showRetainedHost(page: RetainedPage, container: HTMLElement): () => void {
  const syncViewport = (): void => syncBrowserClientPagePaintRetention(page)
  const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(syncViewport)
  observer?.observe(container)
  window.addEventListener('resize', syncViewport)
  window.addEventListener('scroll', syncViewport, true)
  // Pane moves can fire no resize/scroll event; the shared position driver remeasures after layout changes.
  const releasePositionSync = registerBrowserClientPagePositionSync(syncViewport)
  syncViewport()
  // Idempotent: the registry releases a page it tears down, and the pane's own detach follows.
  let stopped = false
  return () => {
    if (stopped) {
      return
    }
    stopped = true
    releasePositionSync()
    observer?.disconnect()
    window.removeEventListener('resize', syncViewport)
    window.removeEventListener('scroll', syncViewport, true)
  }
}
