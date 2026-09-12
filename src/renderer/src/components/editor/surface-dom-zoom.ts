import type { CSSProperties, Dispatch, SetStateAction } from 'react'
import { flushSync } from 'react-dom'
import {
  type SurfaceContentDimensions,
  type SurfaceSize,
  type SurfaceZoomAnchor,
  clampSurfaceZoom,
  getAnchoredSurfaceScrollOffset,
  getNextWheelSurfaceZoom,
  shouldHandleSurfaceZoomWheel
} from './surface-zoom'

export type ApplySurfaceZoomChange = (
  getNextZoom: (currentZoom: number) => number,
  anchor?: SurfaceZoomAnchor | null
) => void

export function getElementSurfaceSize(element: HTMLElement): SurfaceSize {
  return {
    width: element.clientWidth,
    height: element.clientHeight
  }
}

export function getSurfaceLayoutStyle(
  size: SurfaceContentDimensions | null
): CSSProperties | undefined {
  if (!size) {
    return undefined
  }

  return {
    width: `${size.width}px`,
    height: `${size.height}px`
  }
}

export function applyAnchoredSurfaceZoomChange(
  surface: HTMLDivElement | null,
  setZoom: Dispatch<SetStateAction<number>>,
  getNextZoom: (currentZoom: number) => number,
  anchor?: SurfaceZoomAnchor | null
): void {
  const resolvedAnchor = surface
    ? (anchor ?? { x: surface.clientWidth / 2, y: surface.clientHeight / 2 })
    : null
  const scrollLeft = surface?.scrollLeft ?? 0
  const scrollTop = surface?.scrollTop ?? 0
  let currentZoom = 1
  let nextZoom = 1

  flushSync(() => {
    setZoom((current) => {
      currentZoom = current
      nextZoom = clampSurfaceZoom(getNextZoom(current))
      return nextZoom
    })
  })

  if (!surface || !resolvedAnchor || currentZoom === nextZoom) {
    return
  }

  surface.scrollLeft = getAnchoredSurfaceScrollOffset({
    scrollOffset: scrollLeft,
    anchorOffset: resolvedAnchor.x,
    currentZoom,
    nextZoom
  })
  surface.scrollTop = getAnchoredSurfaceScrollOffset({
    scrollOffset: scrollTop,
    anchorOffset: resolvedAnchor.y,
    currentZoom,
    nextZoom
  })
}

export function applySurfaceWheel(
  event: WheelEvent,
  applyZoomChange: ApplySurfaceZoomChange
): void {
  if (!shouldHandleSurfaceZoomWheel(event)) {
    return
  }

  event.preventDefault()
  event.stopPropagation()
  const surface = event.currentTarget instanceof HTMLDivElement ? event.currentTarget : null
  const rect = surface?.getBoundingClientRect()
  applyZoomChange(
    (currentZoom) => getNextWheelSurfaceZoom(currentZoom, event.deltaY, event.deltaMode),
    rect ? { x: event.clientX - rect.left, y: event.clientY - rect.top } : null
  )
}
