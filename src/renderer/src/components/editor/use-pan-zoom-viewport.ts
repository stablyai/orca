import type React from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getPinchZoomFactor, getWheelDeltaPixels } from './image-viewer-zoom'
import {
  type PanZoomPoint,
  type PanZoomSize,
  type PanZoomView,
  containPanZoomView,
  getFittedPanZoomView,
  getMaxPanZoom,
  getMinPanZoom,
  getPanZoomFitScale,
  getPanZoomViewOffset,
  panView,
  zoomViewAt
} from '../../../../shared/pan-zoom-view'

type ZoomStep = (zoom: number, fitScale: number) => number

/** Movement under this many pixels still counts as a click. */
const CLICK_SLOP = 4

type PointerGesture = { start: PanZoomPoint; last: PanZoomPoint; pan: boolean; alt: boolean }

// Pinch zoom back to the fit lands near, not on, 1.
const FIT_ZOOM_EPSILON = 1e-3

export type PanZoomCursor = 'zoom-in' | 'zoom-out' | 'grab' | 'grabbing'

type PanZoomGeometry = {
  content: PanZoomSize
  viewport: PanZoomSize
  fitScale: number
  contain: boolean
}

export type PanZoomViewport = {
  canvas: HTMLDivElement | null
  setCanvas: (canvas: HTMLDivElement | null) => void
  canvasHandlers: Pick<
    React.HTMLAttributes<HTMLDivElement>,
    'onPointerDown' | 'onPointerMove' | 'onPointerUp' | 'onPointerCancel' | 'onLostPointerCapture'
  >
  /** What a click or drag would do here; null when it does nothing. */
  cursor: PanZoomCursor | null
  /** Rendered pixels per content unit; 1 is actual size. */
  scale: number
  offset: PanZoomPoint | null
  isFitted: boolean
  canZoomIn: boolean
  canZoomOut: boolean
  zoomBy: (factor: number) => void
  fit: () => void
  showActualSize: () => void
}

// A pane resize can leave a contained view past the new edges.
function settleView(view: PanZoomView, geometry: PanZoomGeometry): PanZoomView {
  return geometry.contain ? containPanZoomView(view, geometry) : view
}

/** Fit, wheel/pinch zoom at the cursor, click to toggle fit and actual size, and Alt-drag to pan. */
export function usePanZoomViewport({
  content,
  upscale = false,
  contain = false
}: {
  content: PanZoomSize | null
  /** Let fit enlarge content past its natural size; vectors stay sharp. */
  upscale?: boolean
  /** Stop panning at the content's edges, keeping content that fits centered. */
  contain?: boolean
}): PanZoomViewport {
  // State, not a ref: a dialog's portal canvas mounts after this component's first effects.
  const [canvas, setCanvas] = useState<HTMLDivElement | null>(null)
  const gestureRef = useRef<PointerGesture | null>(null)
  const [viewport, setViewport] = useState<PanZoomSize | null>(null)
  // null is the fitted view, so it follows the canvas as it resizes.
  const [manualView, setManualView] = useState<PanZoomView | null>(null)
  const [dragging, setDragging] = useState(false)
  const [altHeld, setAltHeld] = useState(false)

  const [viewContent, setViewContent] = useState(content)
  if (
    viewContent?.width !== content?.width ||
    viewContent?.height !== content?.height ||
    (viewContent === null) !== (content === null)
  ) {
    setViewContent(content)
    setManualView(null)
  }

  const geometry = useMemo<PanZoomGeometry | null>(() => {
    if (!content || !viewport) {
      return null
    }
    return {
      content,
      viewport,
      fitScale: getPanZoomFitScale(content, viewport, undefined, upscale),
      contain
    }
  }, [content, viewport, upscale, contain])

  // Zoom commands that arrive before the image has a size; diff sides must stay in step.
  const [pendingZoom, setPendingZoom] = useState<ZoomStep[]>([])
  if (geometry && pendingZoom.length > 0) {
    setPendingZoom([])
    setManualView((current) =>
      pendingZoom.reduce(
        (from, getNextZoom) =>
          zoomViewAt({
            ...geometry,
            view: from,
            nextZoom: getNextZoom(from.zoom, geometry.fitScale),
            anchor: { x: geometry.viewport.width / 2, y: geometry.viewport.height / 2 }
          }),
        current ? settleView(current, geometry) : getFittedPanZoomView(geometry.content)
      )
    )
  }
  const view =
    manualView && geometry
      ? settleView(manualView, geometry)
      : (manualView ?? (content ? getFittedPanZoomView(content) : null))

  useEffect(() => {
    if (!canvas) {
      return
    }
    // observe() delivers the initial size, so no synchronous measure is needed.
    const observer = new ResizeObserver(() =>
      setViewport({ width: canvas.clientWidth, height: canvas.clientHeight })
    )
    observer.observe(canvas)
    return () => observer.disconnect()
  }, [canvas])

  useEffect(() => {
    if (!canvas || !geometry) {
      return
    }
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault()
      const fitted = getFittedPanZoomView(geometry.content)
      if (event.ctrlKey) {
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
  }, [canvas, geometry])

  useEffect(() => {
    if (!canvas) {
      return
    }
    const onKey = (event: KeyboardEvent): void => setAltHeld(event.altKey)
    const onBlur = (): void => setAltHeld(false)
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('keyup', onKey, true)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('keyup', onKey, true)
      window.removeEventListener('blur', onBlur)
    }
  }, [canvas])

  const zoomTo = useCallback(
    (getNextZoom: ZoomStep) => {
      if (!geometry) {
        setPendingZoom((queued) => [...queued, getNextZoom])
        return
      }
      setManualView((current) => {
        const from = current
          ? settleView(current, geometry)
          : getFittedPanZoomView(geometry.content)
        return zoomViewAt({
          ...geometry,
          view: from,
          nextZoom: getNextZoom(from.zoom, geometry.fitScale),
          anchor: { x: geometry.viewport.width / 2, y: geometry.viewport.height / 2 }
        })
      })
    },
    [geometry]
  )
  const zoomBy = useCallback((factor: number) => zoomTo((zoom) => zoom * factor), [zoomTo])
  const showActualSize = useCallback(() => zoomTo((_, fitScale) => 1 / fitScale), [zoomTo])
  const fit = useCallback(() => {
    setPendingZoom([])
    setManualView(null)
  }, [])

  // Like Chromium's image view: a click flips between the fit and actual size at the cursor.
  const atFit = !view || Math.abs(view.zoom - 1) < FIT_ZOOM_EPSILON
  const fitIsActualSize = !geometry || Math.abs(geometry.fitScale - 1) < FIT_ZOOM_EPSILON
  const toggleZoomAt = useCallback(
    (anchor: PanZoomPoint) => {
      if (!geometry) {
        return
      }
      if (!atFit) {
        fit()
        return
      }
      if (fitIsActualSize) {
        return
      }
      // From the current view: an uncontained fit may already be panned.
      setManualView((current) =>
        zoomViewAt({
          ...geometry,
          view: current ? settleView(current, geometry) : getFittedPanZoomView(geometry.content),
          nextZoom: 1 / geometry.fitScale,
          anchor
        })
      )
    },
    [atFit, fit, fitIsActualSize, geometry]
  )

  const endDrag = useCallback(() => {
    gestureRef.current = null
    setDragging(false)
  }, [])
  const canvasHandlers = useMemo<PanZoomViewport['canvasHandlers']>(
    () => ({
      onPointerDown: (event) => {
        if (event.button !== 0 || !geometry) {
          return
        }
        event.currentTarget.setPointerCapture(event.pointerId)
        const point = { x: event.clientX, y: event.clientY }
        // Touch and pen have no Alt key, so they keep dragging to pan.
        const pan = event.altKey || event.pointerType === 'touch' || event.pointerType === 'pen'
        gestureRef.current = { start: point, last: point, pan, alt: event.altKey }
        setDragging(pan)
      },
      onPointerMove: (event) => {
        setAltHeld(event.altKey)
        const gesture = gestureRef.current
        if (!gesture?.pan || !geometry) {
          return
        }
        const last = gesture.last
        gesture.last = { x: event.clientX, y: event.clientY }
        const delta = { x: event.clientX - last.x, y: event.clientY - last.y }
        // Compose every pointer move even when several arrive before React renders.
        setManualView((current) => {
          const from = current
            ? settleView(current, geometry)
            : getFittedPanZoomView(geometry.content)
          return panView(
            from,
            delta,
            geometry.fitScale * from.zoom,
            geometry.content,
            geometry.contain ? geometry.viewport : null
          )
        })
      },
      onPointerUp: (event) => {
        const gesture = gestureRef.current
        endDrag()
        if (!gesture || gesture.alt) {
          return
        }
        const moved = Math.hypot(event.clientX - gesture.start.x, event.clientY - gesture.start.y)
        if (moved < CLICK_SLOP) {
          const rect = event.currentTarget.getBoundingClientRect()
          toggleZoomAt({ x: event.clientX - rect.left, y: event.clientY - rect.top })
        }
      },
      onPointerCancel: endDrag,
      onLostPointerCapture: endDrag
    }),
    [endDrag, geometry, toggleZoomAt]
  )

  let cursor: PanZoomCursor | null = null
  if (dragging) {
    cursor = 'grabbing'
  } else if (altHeld) {
    cursor = 'grab'
  } else if (geometry && view && (!atFit || !fitIsActualSize)) {
    // Zoom is relative to the fit, so a click's target is 1/fitScale from the fit and 1 otherwise.
    const targetZoom = atFit ? 1 / geometry.fitScale : 1
    cursor = targetZoom > view.zoom ? 'zoom-in' : 'zoom-out'
  }

  const scale = geometry && view ? geometry.fitScale * view.zoom : 0
  return {
    canvas,
    setCanvas,
    canvasHandlers,
    cursor,
    scale,
    offset: geometry && view ? getPanZoomViewOffset(view, geometry.viewport, scale) : null,
    isFitted: manualView === null,
    canZoomIn: !!geometry && !!view && view.zoom < getMaxPanZoom(geometry.fitScale),
    canZoomOut: !!geometry && !!view && view.zoom > getMinPanZoom(geometry.fitScale),
    zoomBy,
    fit,
    showActualSize
  }
}
