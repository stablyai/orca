import { useEffect } from 'react'
import { cssPxToWindowDip } from '@/lib/ui-zoom'
import {
  shouldShowBrowserPageViewportSizeFeedback,
  toBrowserPageGuestViewportSize,
  type BrowserPageViewportSize
} from './browser-page-viewport-size'

/** The guest's live zoom level, or null until it can be read. */
function readGuestZoomLevel(webview: Electron.WebviewTag | null): number | null {
  if (!webview) {
    return null
  }
  try {
    // Why the live level: an embedder (UI) zoom change overwrites the guest's zoom behind Orca's back.
    return webview.getZoomLevel()
  } catch {
    // getZoomLevel throws until dom-ready, which is also when a saved site zoom lands.
    return null
  }
}

/** Reports the guest viewport size whenever the active pane's page box is resized. */
export function useBrowserPageViewportSizeFeedback(
  content: HTMLDivElement | null,
  isActive: boolean,
  webviewRef: React.RefObject<Electron.WebviewTag | null>,
  {
    showBrowserViewportSizeFeedback,
    hideBrowserFeedback
  }: {
    showBrowserViewportSizeFeedback: (size: BrowserPageViewportSize) => void
    hideBrowserFeedback: () => void
  }
): void {
  useEffect(() => {
    if (!content || !isActive || typeof ResizeObserver === 'undefined') {
      return
    }
    // Why reset per activation: ResizeObserver's first callback is the current size, not a resize.
    // Why host DIP: the baseline must survive measurements taken before the guest zoom is readable.
    let previousHostDip: BrowserPageViewportSize | null = null
    const observer = new ResizeObserver((entries) => {
      const box = entries.at(-1)?.contentRect
      if (!box) {
        return
      }
      // Why: a parked page (workspace switch) measures 0×0 while still active; a running flash
      // would come back with a stale size, and the next size is only a baseline.
      if (box.width === 0 || box.height === 0) {
        previousHostDip = null
        hideBrowserFeedback()
        return
      }
      const hostDip = { width: cssPxToWindowDip(box.width), height: cssPxToWindowDip(box.height) }
      const guestZoomLevel = readGuestZoomLevel(webviewRef.current)
      // Why skip the flash but keep the baseline: a size computed at a guessed zoom is worse than
      // no size, yet the first resize after dom-ready must still be announced.
      if (guestZoomLevel === null) {
        previousHostDip = hostDip
        return
      }
      const previous = previousHostDip
        ? toBrowserPageGuestViewportSize(previousHostDip, guestZoomLevel)
        : null
      const next = toBrowserPageGuestViewportSize(hostDip, guestZoomLevel)
      previousHostDip = hostDip
      if (shouldShowBrowserPageViewportSizeFeedback(previous, next)) {
        showBrowserViewportSizeFeedback(next)
      }
    })
    observer.observe(content)
    return () => {
      observer.disconnect()
      // Why: an inactive page is no longer measured, so a running flash would go stale.
      hideBrowserFeedback()
    }
  }, [content, isActive, webviewRef, showBrowserViewportSizeFeedback, hideBrowserFeedback])
}
