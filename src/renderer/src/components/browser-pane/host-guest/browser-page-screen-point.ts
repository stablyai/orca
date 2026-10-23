import { windowDipToCssPx } from '@/lib/ui-zoom'

/**
 * Whether the OS cursor is over this page rather than over something drawn above it, such as a
 * dialog or the floating workspace panel. Hit testing, not rects, settles which page owns it.
 */
export function isBrowserPageAtScreenPoint(
  page: Element | null,
  screenX: number,
  screenY: number
): boolean {
  if (!page) {
    return false
  }
  const hit = document.elementFromPoint(
    windowDipToCssPx(screenX - window.screenX),
    windowDipToCssPx(screenY - window.screenY)
  )
  return hit !== null && page.contains(hit)
}
