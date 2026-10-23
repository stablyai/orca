import { browserPageZoomLevelToFactor } from '../../../../../shared/browser-page-zoom'

export type BrowserPageViewportSize = { width: number; height: number }

/** Guest `innerWidth`/`innerHeight` for a host box measured in window DIP. */
export function toBrowserPageGuestViewportSize(
  hostBoxWindowDip: BrowserPageViewportSize,
  pageZoomLevel: number
): BrowserPageViewportSize {
  const zoomFactor = browserPageZoomLevelToFactor(pageZoomLevel)
  // Why: mirrors Blink's AdjustForAbsoluteZoom::AdjustInt on the guest's integer DIP size, which
  // adds 1 before truncating when zoomed in; the epsilon absorbs float error like 1199.9999.
  const toGuestPx = (dip: number): number => {
    const wholeDip = Math.round(dip)
    if (zoomFactor === 1) {
      return wholeDip
    }
    return Math.floor((zoomFactor > 1 ? wholeDip + 1 : wholeDip) / zoomFactor + 1e-6)
  }
  return { width: toGuestPx(hostBoxWindowDip.width), height: toGuestPx(hostBoxWindowDip.height) }
}

/** Whether a measured size change is a real resize worth announcing. */
export function shouldShowBrowserPageViewportSizeFeedback(
  previous: BrowserPageViewportSize | null,
  next: BrowserPageViewportSize
): boolean {
  // Why: a hidden pane measures 0×0, so showing it again (tab or workspace switch) is not a resize.
  if (!previous || previous.width === 0 || previous.height === 0) {
    return false
  }
  if (next.width === 0 || next.height === 0) {
    return false
  }
  return previous.width !== next.width || previous.height !== next.height
}

export function formatBrowserPageViewportSize(size: BrowserPageViewportSize): string {
  return `${size.width} × ${size.height}`
}
