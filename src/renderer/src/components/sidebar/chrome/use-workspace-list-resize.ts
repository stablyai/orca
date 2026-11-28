import { useCallback } from 'react'
import { clampSidebarResizeWidth, useSidebarResize } from '@/hooks/useSidebarResize'
import { scaledSidebarWidthCss } from './sidebar-drawer-left-edge'
import { setSidebarLiveWidth } from './sidebar-live-width'

const MIN_WIDTH = 220
const MAX_WIDTH = 500

function measureWidthFromDelta(element: HTMLDivElement, saved: number) {
  const zoom = element.currentCSSZoom || 1
  const ratio = zoom / (document.documentElement.currentCSSZoom || 1)
  if (ratio <= 1) {
    return undefined
  }

  // Invert scaledSidebarWidthCss in local sidebar pixels; a range of saved widths shares the half-window edge.
  const half = window.innerWidth / (2 * zoom)
  const rendered = (width: number) => Math.min(width, Math.max(half, width / ratio))
  const start = rendered(saved)
  const min = rendered(MIN_WIDTH)
  const max = rendered(MAX_WIDTH)
  return (delta: number): number => {
    const edge = clampSidebarResizeWidth(start + delta, min, max)
    if (edge === start) {
      return saved
    }
    if (edge === half) {
      return clampSidebarResizeWidth(saved, half, half * ratio)
    }
    return edge < half ? edge : edge * ratio
  }
}

export function useWorkspaceListResize(
  isOpen: boolean,
  width: number,
  setWidth: (width: number) => void
) {
  const applyRenderedSize = useCallback(
    (element: HTMLDivElement, size: number) => {
      element.style.width = isOpen
        ? `calc(${scaledSidebarWidthCss(`${size}px`)} / var(--sidebar-zoom-ratio, 1))`
        : '0px'
    },
    [isOpen]
  )
  return useSidebarResize<HTMLDivElement>({
    isOpen,
    width,
    setWidth,
    minWidth: MIN_WIDTH,
    maxWidth: MAX_WIDTH,
    measureWidthFromDelta,
    deltaSign: 1,
    applyRenderedSize,
    onDraftWidthChange: setSidebarLiveWidth
  })
}
