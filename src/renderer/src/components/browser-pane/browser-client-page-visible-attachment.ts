import {
  isWebviewDragPassthroughActive,
  registerWebviewDragPassthroughSurface
} from './host-guest/webview-drag-passthrough'
import { registerBrowserClientPagePositionSync } from './browser-client-page-position-driver'
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
  const stopTrackingViewport = showRetainedHost(page.host, container)
  const attachment = { container, stopTrackingViewport }
  page.visibleAttachment = attachment
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
      stopTrackingViewport()
      if (
        pages.get(page.key) === page &&
        page.status === 'attached' &&
        page.visibleAttachment === attachment
      ) {
        page.visibleAttachment = null
        hideRetainedHost(page.host)
      }
    }
  }
}

/** Derive pointer-events from current visibility and drag state; restoring a captured value would fail across mid-drag hide/show. */
function applyRetainedHostPointerEvents(
  host: HTMLDivElement,
  visible: boolean,
  dragPassthrough: boolean
): void {
  host.style.pointerEvents = visible && !dragPassthrough ? 'auto' : 'none'
}

/** Register the body-level host for drag passthrough; hidden creation and derived show state also cover enrollment mid-drag. */
export function enrolRetainedHostDragPassthrough(page: RetainedPage): () => void {
  return registerWebviewDragPassthroughSurface((passthrough) => {
    applyRetainedHostPointerEvents(page.host, page.visibleAttachment !== null, passthrough)
  })
}

function showRetainedHost(host: HTMLDivElement, container: HTMLElement): () => void {
  host.inert = false
  host.removeAttribute('aria-hidden')
  applyRetainedHostPointerEvents(host, true, isWebviewDragPassthroughActive())
  let appliedBounds = ''
  const syncViewport = (): void => {
    const bounds = container.getBoundingClientRect()
    const next = `${bounds.left}|${bounds.top}|${bounds.width}|${bounds.height}`
    if (next === appliedBounds) {
      return
    }
    appliedBounds = next
    Object.assign(host.style, {
      left: `${bounds.left}px`,
      top: `${bounds.top}px`,
      width: `${bounds.width}px`,
      height: `${bounds.height}px`
    })
  }
  const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(syncViewport)
  observer?.observe(container)
  window.addEventListener('resize', syncViewport)
  window.addEventListener('scroll', syncViewport, true)
  // Pane moves can fire no resize/scroll event; the shared position loop remeasures each shown host.
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

function hideRetainedHost(host: HTMLDivElement): void {
  host.inert = true
  host.setAttribute('aria-hidden', 'true')
  Object.assign(host.style, {
    left: '-10000px',
    top: '0',
    width: '1px',
    height: '1px',
    pointerEvents: 'none'
  })
}
