import { useEffect } from 'react'
import { getUIZoomFactor } from '@/lib/ui-zoom'
import { browserPageZoomLevelToFactor } from '../../../../../shared/browser-page-zoom'

export type BrowserPageViewportSize = { width: number; height: number }

/** Guest `innerWidth`/`innerHeight` for a host box measured in window DIP. */
export function toBrowserPageGuestViewportSize(
  hostBoxWindowDip: BrowserPageViewportSize,
  screenScale: number,
  pageZoomFactor: number
): BrowserPageViewportSize {
  const zoomFactor = Math.fround(screenScale * pageZoomFactor)
  const toGuestPx = (dip: number): number => {
    // Why: Chromium sizes the guest frame in whole DIPs, rounding up, then scales it to device
    // pixels; the epsilon absorbs float error like 1200.0000001.
    const devicePx = Math.round(Math.ceil(dip - 1e-3) * screenScale)
    // Why: ports Blink's AdjustForAbsoluteZoom::AdjustInt (float math, +0.5 when zoomed in, then
    // RoundForImpreciseConversion), whose zoom includes the screen scale.
    const value = Math.fround(zoomFactor > 1 ? devicePx + 0.5 : devicePx)
    return Math.trunc(Math.fround(value / zoomFactor) + 0.01)
  }
  return { width: toGuestPx(hostBoxWindowDip.width), height: toGuestPx(hostBoxWindowDip.height) }
}

/** The guest's live zoom level, or null until it can be read. */
function readGuestZoomLevel(webview: Electron.WebviewTag | null): number | null {
  try {
    // Why the live level: an embedder (UI) zoom change overwrites the guest's zoom behind Orca's back.
    return webview?.getZoomLevel() ?? null
  } catch {
    // getZoomLevel throws until dom-ready, which is also when a saved site zoom lands.
    return null
  }
}

/** Reports the guest viewport size whenever the observed page box is resized. */
export function useBrowserPageViewportSizeFeedback(
  content: HTMLDivElement | null,
  enabled: boolean,
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
    if (!content || !enabled || typeof ResizeObserver === 'undefined') {
      return
    }
    // Why reset per enable: ResizeObserver's first callback is the current size, not a resize.
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
      const uiZoomFactor = getUIZoomFactor()
      const hostDip = { width: box.width * uiZoomFactor, height: box.height * uiZoomFactor }
      const previous = previousHostDip
      previousHostDip = hostDip
      // Why skip the flash but keep the baseline: a size computed at a guessed zoom is worse than
      // no size, yet the first resize after dom-ready must still be announced.
      const guestZoomLevel = readGuestZoomLevel(webviewRef.current)
      if (!previous || guestZoomLevel === null) {
        return
      }
      // Why: the renderer's devicePixelRatio includes UI zoom; the guest's scale is the screen's.
      const screenScale = window.devicePixelRatio / uiZoomFactor
      const pageZoomFactor = browserPageZoomLevelToFactor(guestZoomLevel)
      const before = toBrowserPageGuestViewportSize(previous, screenScale, pageZoomFactor)
      const next = toBrowserPageGuestViewportSize(hostDip, screenScale, pageZoomFactor)
      if (before.width !== next.width || before.height !== next.height) {
        showBrowserViewportSizeFeedback(next)
      }
    })
    observer.observe(content)
    return () => {
      observer.disconnect()
      // Why: a disabled page is no longer measured, so a running flash would go stale.
      hideBrowserFeedback()
    }
  }, [content, enabled, webviewRef, showBrowserViewportSizeFeedback, hideBrowserFeedback])
}
