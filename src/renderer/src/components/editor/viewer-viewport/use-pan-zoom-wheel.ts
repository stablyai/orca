import type React from 'react'
import { useEffect } from 'react'
import { getPinchZoomFactor, getWheelDeltaPixels } from './image-viewer-zoom'
import {
  type PanZoomSize,
  type PanZoomView,
  containPanZoomView,
  getFittedPanZoomView,
  panView,
  zoomViewAt
} from '../../../../../shared/document-preview/pan-zoom-view'

export type PanZoomGeometry = {
  content: PanZoomSize
  viewport: PanZoomSize
  fitScale: number
  contain: boolean
}

// A pane resize can leave a contained view past the new edges.
export function settleView(view: PanZoomView, geometry: PanZoomGeometry): PanZoomView {
  return geometry.contain ? containPanZoomView(view, geometry) : view
}

/** Wheel pans and pinch (Ctrl+wheel) zooms at the cursor; with `metaZooms`, ⌘+wheel zooms too. */
export function usePanZoomWheel(
  canvas: HTMLDivElement | null,
  geometry: PanZoomGeometry | null,
  setManualView: React.Dispatch<React.SetStateAction<PanZoomView | null>>,
  metaZooms = false
): void {
  useEffect(() => {
    if (!canvas || !geometry) {
      return
    }
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault()
      const fitted = getFittedPanZoomView(geometry.content)
      // Pinch arrives as Ctrl+wheel.
      if (event.ctrlKey || (metaZooms && event.metaKey)) {
        const rect = canvas.getBoundingClientRect()
        const anchor = { x: event.clientX - rect.left, y: event.clientY - rect.top }
        setManualView((current) => {
          const from = current ? settleView(current, geometry) : fitted
          return zoomViewAt({
            ...geometry,
            view: from,
            nextZoom: from.zoom * getPinchZoomFactor(event.deltaY, event.deltaMode),
            anchor
          })
        })
        return
      }
      // Shift+wheel needs an axis swap on Windows/Linux; macOS already supplies horizontal deltas.
      const sideways = event.shiftKey && event.deltaX === 0
      const deltaX = getWheelDeltaPixels(event.deltaX, event.deltaMode)
      const deltaY = getWheelDeltaPixels(event.deltaY, event.deltaMode)
      const delta = sideways ? { x: -deltaY, y: 0 } : { x: -deltaX, y: -deltaY }
      setManualView((current) => {
        const from = current ? settleView(current, geometry) : fitted
        return panView(
          from,
          delta,
          geometry.fitScale * from.zoom,
          geometry.content,
          geometry.contain ? geometry.viewport : null
        )
      })
    }
    // Non-passive so pinch can cancel browser zoom.
    canvas.addEventListener('wheel', onWheel, { passive: false })
    return () => canvas.removeEventListener('wheel', onWheel)
  }, [canvas, geometry, metaZooms, setManualView])
}
