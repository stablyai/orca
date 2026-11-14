import { hideRetainedHostWhileGuestIsBlank } from './browser-client-page-retained-elements'
import { isWebviewDragPassthroughActive } from './host-guest/webview-drag-passthrough'
import {
  isBrowserPageRemotelyViewed,
  onBrowserRemoteViewerChange
} from '../../runtime/browser/ownership/browser-remote-viewer-store'
import type { BrowserClientRetainedRendererPage } from './browser-client-page-retained-state'

export function syncBrowserClientPagePaintRetention(page: BrowserClientRetainedRendererPage): void {
  const bounds = page.visibleAttachment?.container.getBoundingClientRect()
  const visible = Boolean(bounds && bounds.width > 0 && bounds.height > 0)
  const viewed = isBrowserPageRemotelyViewed(page.identity.browserPageId)
  const blank = page.host.dataset.browserClientPageBlank === 'true'
  const viewport = page.host.ownerDocument.defaultView
  const interactive = visible && !blank
  // Chromium needs a sized, onscreen guest to composite even when its desktop pane is hidden.
  const style = {
    left: visible ? `${bounds!.left}px` : viewed ? '0px' : '-10000px',
    top: visible ? `${bounds!.top}px` : '0px',
    width: visible
      ? `${bounds!.width}px`
      : viewed
        ? `${Math.max(320, viewport?.innerWidth ?? 0)}px`
        : '1px',
    height: visible
      ? `${bounds!.height}px`
      : viewed
        ? `${Math.max(240, viewport?.innerHeight ?? 0)}px`
        : '1px',
    opacity: interactive ? '' : viewed ? '0' : '',
    visibility: blank && !viewed ? 'hidden' : '',
    'pointer-events': interactive && !isWebviewDragPassthroughActive() ? 'auto' : 'none'
  }
  for (const [property, value] of Object.entries(style)) {
    if (page.host.style.getPropertyValue(property) !== value) {
      page.host.style.setProperty(property, value)
    }
  }
  if (page.host.inert !== !interactive) {
    page.host.inert = !interactive
  }
  if (interactive) {
    if (page.host.hasAttribute('aria-hidden')) {
      page.host.removeAttribute('aria-hidden')
    }
  } else if (page.host.getAttribute('aria-hidden') !== 'true') {
    page.host.setAttribute('aria-hidden', 'true')
  }
}

export function retainBrowserClientPagePaint(page: BrowserClientRetainedRendererPage): () => void {
  syncBrowserClientPagePaintRetention(page)
  return onBrowserRemoteViewerChange((browserPageId) => {
    if (browserPageId === page.identity.browserPageId) {
      syncBrowserClientPagePaintRetention(page)
    }
  })
}

export function createBrowserClientPageLoadCommitHandler(page: BrowserClientRetainedRendererPage) {
  const onLoadCommit = hideRetainedHostWhileGuestIsBlank(page.host)
  return (event: Electron.LoadCommitEvent): void => {
    onLoadCommit(event)
    syncBrowserClientPagePaintRetention(page)
  }
}
