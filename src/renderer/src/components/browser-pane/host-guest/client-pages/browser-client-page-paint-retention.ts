import { hideRetainedHostWhileGuestIsBlank } from './browser-client-page-retained-elements'
import { isWebviewDragPassthroughActive } from '../drag/webview-drag-passthrough'
import {
  browserGuestActivity,
  registerBrowserGuestActivity,
  reportBrowserGuestVisibility,
  setBrowserGuestVisible,
  unregisterBrowserGuestActivity
} from '../browser-guest-activity'
import { registerBrowserClientPagePositionSync } from '../viewport/browser-client-page-position-driver'
import {
  browserPageNeedsPaintRetention,
  onBrowserGuestPaintRetentionChange
} from '../retention/browser-page-paint-retention-terms'
import type { BrowserClientRetainedRendererPage } from './browser-client-page-retained-state'

export function syncBrowserClientPagePaintRetention(page: BrowserClientRetainedRendererPage): void {
  const container = page.visibleAttachment?.container
  const bounds = container?.getBoundingClientRect()
  const visible = Boolean(bounds && bounds.width > 0 && bounds.height > 0)
  const shown = Boolean(container && isBrowserClientPageContainerShown(container, bounds))
  // An agent's capture or input, a phone or a paired viewer needs frames, as for a local page.
  const retained = browserPageNeedsPaintRetention(page.identity.browserPageId)
  const blank = page.host.dataset.browserClientPageBlank === 'true'
  const viewport = page.host.ownerDocument.defaultView
  const interactive = shown && !blank
  if (browserGuestActivity.get(page.identity.browserPageId)?.webview === page.webview) {
    setBrowserGuestVisible(page.identity.browserPageId, shown)
  }
  // A preset can outsize the pane; the body-level host must not paint or take input past the scroller's client box, which leaves its scrollbars uncovered.
  const scroller = visible ? container!.closest('[data-browser-page-scroller]') : null
  const clipInsets = scroller
    ? scrollerClipInsets(bounds!, scroller.getBoundingClientRect(), scroller)
    : []
  // Chromium needs a sized, onscreen guest to composite even when its desktop pane is hidden.
  const style = {
    left: visible ? `${bounds!.left}px` : retained ? '0px' : '-10000px',
    top: visible ? `${bounds!.top}px` : '0px',
    width: visible
      ? `${bounds!.width}px`
      : retained
        ? `${Math.max(320, viewport?.innerWidth ?? 0)}px`
        : '1px',
    height: visible
      ? `${bounds!.height}px`
      : retained
        ? `${Math.max(240, viewport?.innerHeight ?? 0)}px`
        : '1px',
    opacity: interactive ? '' : retained || visible ? '0' : '',
    visibility: blank && !retained ? 'hidden' : '',
    'pointer-events': interactive && !isWebviewDragPassthroughActive() ? 'auto' : 'none',
    'clip-path': clipInsets.some((inset) => inset > 0)
      ? `inset(${clipInsets.map((inset) => `${inset}px`).join(' ')})`
      : ''
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

/** The pane shows its page: sized, and not hidden by an ancestor's opacity or visibility. */
function isBrowserClientPageContainerShown(
  container: HTMLElement,
  bounds = container.getBoundingClientRect()
): boolean {
  // The host lives in <body>, so ancestor opacity hiding a retained inactive pane never reaches it.
  return (
    bounds.width > 0 &&
    bounds.height > 0 &&
    container.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
  )
}

/** Runs `onShown` once the pane shows, so a freed page is remade only when someone looks. */
export function whenBrowserClientPageContainerShown(
  container: HTMLElement,
  onShown: () => void
): () => void {
  let stopped = false
  const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => check())
  const releasePositionSync = registerBrowserClientPagePositionSync(() => check())
  const stop = (): void => {
    stopped = true
    observer?.disconnect()
    releasePositionSync()
  }
  const check = (): void => {
    if (!stopped && isBrowserClientPageContainerShown(container)) {
      stop()
      onShown()
    }
  }
  observer?.observe(container)
  check()
  return stop
}

function scrollerClipInsets(bounds: DOMRect, scrollerBounds: DOMRect, scroller: Element): number[] {
  const left = scrollerBounds.left + scroller.clientLeft
  const top = scrollerBounds.top + scroller.clientTop
  return [
    top - bounds.top,
    bounds.right - (left + scroller.clientWidth),
    bounds.bottom - (top + scroller.clientHeight),
    left - bounds.left
  ].map((inset) => Math.max(0, inset))
}

/** Memory Saver frees a hidden This-device page the way it frees a hidden local tab. */
export function trackBrowserClientPageGuestActivity(page: BrowserClientRetainedRendererPage): void {
  registerBrowserGuestActivity(page.identity.browserPageId, page.webview)
  syncBrowserClientPagePaintRetention(page)
}

/** A profile switch's two guests share a page id: the survivor of a retired one reports again. */
export function forgetBrowserClientPageGuestActivity(
  page: BrowserClientRetainedRendererPage,
  pages: Iterable<BrowserClientRetainedRendererPage>
): void {
  if (browserGuestActivity.get(page.identity.browserPageId)?.webview !== page.webview) {
    return
  }
  unregisterBrowserGuestActivity(page.identity.browserPageId)
  let survivor: BrowserClientRetainedRendererPage | null = null
  for (const candidate of pages) {
    if (
      candidate !== page &&
      candidate.status === 'attached' &&
      candidate.identity.browserPageId === page.identity.browserPageId &&
      (!survivor || candidate.identity.pageHostGeneration > survivor.identity.pageHostGeneration)
    ) {
      survivor = candidate
    }
  }
  if (survivor) {
    trackBrowserClientPageGuestActivity(survivor)
  }
}

export function retainBrowserClientPagePaint(page: BrowserClientRetainedRendererPage): () => void {
  syncBrowserClientPagePaintRetention(page)
  return onBrowserGuestPaintRetentionChange((browserPageId) => {
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
    // Main binds the guest after mount and before its first navigation; report again once it can hear.
    if (
      event.isMainFrame &&
      browserGuestActivity.get(page.identity.browserPageId)?.webview === page.webview
    ) {
      reportBrowserGuestVisibility(page.identity.browserPageId)
    }
  }
}
