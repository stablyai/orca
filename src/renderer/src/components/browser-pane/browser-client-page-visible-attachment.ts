import {
  isWebviewDragPassthroughActive,
  registerWebviewDragPassthroughSurface
} from './host-guest/webview-drag-passthrough'
import type { BrowserClientRetainedRendererPage as RetainedPage } from './browser-client-page-retained-state'

export type BrowserClientPageVisibleAttachment = {
  webview: Electron.WebviewTag
  nextMetadataRevision(): number
  detach(): void
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
  const attachment = { container }
  page.visibleAttachment = attachment
  const stopTrackingViewport = showRetainedHost(page.host, container)
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

/** The retained host's click-through state is derived, never saved and restored: it is the
 *  only writer of the property, and a drag spanning a hide/show would otherwise put back a
 *  value captured under the opposite visibility. */
function applyRetainedHostPointerEvents(
  host: HTMLDivElement,
  visible: boolean,
  dragPassthrough: boolean
): void {
  host.style.pointerEvents = visible && !dragPassthrough ? 'auto' : 'none'
}

/** Enrols a retained host in the shared guest passthrough set, so a drag reaches the document
 *  through this body-level overlay the way it already does through local pane guests. A host
 *  enrolled mid-drag needs no settling: it is created hidden, and its show derives the state. */
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
  // Why: a pane can MOVE without resizing (tab dragged across an even split, sidebar toggles),
  // which fires no resize/scroll event — the overlay would keep painting at the old pane's rect.
  let positionFrame: number | null = null
  const trackPosition = (): void => {
    syncViewport()
    positionFrame = requestAnimationFrame(trackPosition)
  }
  if (typeof requestAnimationFrame === 'function') {
    positionFrame = requestAnimationFrame(trackPosition)
  }
  syncViewport()
  return () => {
    if (positionFrame !== null) {
      cancelAnimationFrame(positionFrame)
    }
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
