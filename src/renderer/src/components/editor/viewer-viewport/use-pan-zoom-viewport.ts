import type React from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { type PanZoomGeometry, settleView, usePanZoomWheel } from './use-pan-zoom-wheel'
import {
  type PanZoomPoint,
  type PanZoomSize,
  type PanZoomView,
  getFittedPanZoomView,
  getMaxPanZoom,
  getMinPanZoom,
  getPanZoomFitScale,
  getPanZoomViewOffset,
  isPointOnPanZoomContent,
  panView,
  zoomViewAt
} from '../../../../../shared/document-preview/pan-zoom-view'

type ZoomStep = (zoom: number, fitScale: number) => number

/** Movement under this many pixels still counts as a click. */
const CLICK_SLOP = 4

// `moved`: once past the slop it stays a drag, even if it ends back at the start.
type PointerGesture = {
  pointerId: number
  start: PanZoomPoint
  last: PanZoomPoint
  pan: boolean
  alt: boolean
  moved: boolean
}

// Pinch zoom back to the fit lands near, not on, 1.
const FIT_ZOOM_EPSILON = 1e-3

export type PanZoomCursor = 'zoom-in' | 'zoom-out' | 'grab' | 'grabbing'

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

/** Fit, wheel/pinch zoom at the cursor, click to toggle fit and actual size, and Alt-drag to pan. */
export function usePanZoomViewport({
  content,
  upscale = false,
  contain = false,
  fitPadding,
  actualSizeClickZoom,
  zoomedDragPans = false,
  onClickOutsideContent
}: {
  content: PanZoomSize | null
  /** Let fit enlarge content past its natural size; vectors stay sharp. */
  upscale?: boolean
  /** Stop panning at the content's edges, keeping content that fits centered. */
  contain?: boolean
  /** Margin kept around fitted content, in pixels. */
  fitPadding?: number
  /** Zoom (relative to the fit) a click reaches when the fit already shows actual size. */
  actualSizeClickZoom?: number
  /** Once zoomed in, a plain drag pans; at the fit it still does nothing. */
  zoomedDragPans?: boolean
  /** A click (not a drag) beside the content runs this instead of toggling zoom. */
  onClickOutsideContent?: () => void
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
      fitScale: getPanZoomFitScale(content, viewport, fitPadding, upscale),
      contain
    }
  }, [content, viewport, fitPadding, upscale, contain])

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
  const scale = geometry && view ? geometry.fitScale * view.zoom : 0
  const offset = geometry && view ? getPanZoomViewOffset(view, geometry.viewport, scale) : null

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

  usePanZoomWheel(canvas, geometry, setManualView)

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
  // Where a click from the fit zooms to; none when the fit is actual size and no step is set.
  const clickZoom = !geometry
    ? undefined
    : fitIsActualSize
      ? actualSizeClickZoom
      : 1 / geometry.fitScale
  const toggleZoomAt = useCallback(
    (anchor: PanZoomPoint) => {
      if (!geometry) {
        return
      }
      if (!atFit) {
        fit()
        return
      }
      if (!clickZoom) {
        return
      }
      // From the current view: an uncontained fit may already be panned.
      setManualView((current) =>
        zoomViewAt({
          ...geometry,
          view: current ? settleView(current, geometry) : getFittedPanZoomView(geometry.content),
          nextZoom: clickZoom,
          anchor
        })
      )
    },
    [atFit, clickZoom, fit, geometry]
  )

  const endDrag = useCallback(() => {
    gestureRef.current = null
    setDragging(false)
  }, [])
  const ownGesture = (event: React.PointerEvent): PointerGesture | null =>
    gestureRef.current?.pointerId === event.pointerId ? gestureRef.current : null
  const canvasHandlers = useMemo<PanZoomViewport['canvasHandlers']>(
    () => ({
      onPointerDown: (event) => {
        // A second finger joins nothing: only the first pointer drives the gesture.
        if (event.button !== 0 || gestureRef.current || (!geometry && !onClickOutsideContent)) {
          return
        }
        event.currentTarget.setPointerCapture(event.pointerId)
        const point = { x: event.clientX, y: event.clientY }
        // Touch and pen have no Alt key, so they keep dragging to pan.
        const pan =
          event.altKey ||
          event.pointerType === 'touch' ||
          event.pointerType === 'pen' ||
          (zoomedDragPans && !atFit)
        const { pointerId, altKey: alt } = event
        gestureRef.current = { pointerId, start: point, last: point, pan, alt, moved: false }
        setDragging(pan)
      },
      onPointerMove: (event) => {
        setAltHeld(event.altKey)
        const gesture = ownGesture(event)
        if (gesture && !gesture.moved) {
          const { x, y } = gesture.start
          gesture.moved = Math.hypot(event.clientX - x, event.clientY - y) >= CLICK_SLOP
        }
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
        const gesture = ownGesture(event)
        if (!gesture) {
          return
        }
        endDrag()
        if (gesture.alt) {
          return
        }
        const moved = Math.hypot(event.clientX - gesture.start.x, event.clientY - gesture.start.y)
        if (gesture.moved || moved >= CLICK_SLOP) {
          return
        }
        const rect = event.currentTarget.getBoundingClientRect()
        const point = { x: event.clientX - rect.left, y: event.clientY - rect.top }
        const onContent =
          geometry && offset && isPointOnPanZoomContent(point, offset, geometry.content, scale)
        if (onClickOutsideContent && !onContent) {
          onClickOutsideContent()
        } else {
          toggleZoomAt(point)
        }
      },
      onPointerCancel: (event) => ownGesture(event) && endDrag(),
      onLostPointerCapture: (event) => ownGesture(event) && endDrag()
    }),
    [atFit, endDrag, geometry, offset, onClickOutsideContent, scale, toggleZoomAt, zoomedDragPans]
  )

  let cursor: PanZoomCursor | null = null
  if (dragging) {
    cursor = 'grabbing'
  } else if (altHeld) {
    cursor = 'grab'
  } else if (geometry && view && (!atFit || clickZoom)) {
    // Zoom is relative to the fit, so a click's target is clickZoom from the fit and 1 otherwise.
    const targetZoom = atFit ? (clickZoom ?? 1) : 1
    cursor = targetZoom > view.zoom ? 'zoom-in' : 'zoom-out'
  }

  return {
    canvas,
    setCanvas,
    canvasHandlers,
    cursor,
    scale,
    offset,
    isFitted: manualView === null,
    canZoomIn: !!geometry && !!view && view.zoom < getMaxPanZoom(geometry.fitScale),
    canZoomOut: !!geometry && !!view && view.zoom > getMinPanZoom(geometry.fitScale),
    zoomBy,
    fit,
    showActualSize
  }
}
