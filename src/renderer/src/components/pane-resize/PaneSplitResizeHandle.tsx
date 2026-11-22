import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { acquireWebviewsDragPassthrough } from '../browser-pane/host-guest/drag/webview-drag-passthrough'
import { getDraggedSplitRatio, measureSplitRatio, readSplitRatio } from './pane-split-drag-ratio'
import {
  getThinSeamGrabSegments,
  sameGrabSegments,
  type GrabSegment
} from './thin-seam-grab-segments'

const TAB_ROW_SELECTOR = '[data-tab-group-strip-id]'
// Matches --divider-grab-reach in main.css, for when the variable can't be read.
const DEFAULT_GRAB_REACH_PX = 7
const WHOLE_SEAM: React.CSSProperties[] = [{}]

/**
 * Keeps a vertical thin seam's grab segments off the tab rows rendered at its right edge. Reads real
 * row bounds, so nested 1px seams and live drags of inner splits (which resize groups) stay exact.
 */
function useTabRowGrabSegments(
  handleRef: React.RefObject<HTMLDivElement | null>,
  enabled: boolean,
  layoutKey: unknown
): GrabSegment[] | null {
  const [segments, setSegments] = useState<GrabSegment[] | null>(null)
  useLayoutEffect(() => {
    const handle = handleRef.current
    const secondPane = handle?.nextElementSibling
    if (!enabled || !handle || !secondPane) {
      setSegments(null)
      return
    }
    const reachPx =
      Number.parseFloat(getComputedStyle(handle).getPropertyValue('--divider-grab-reach')) ||
      DEFAULT_GRAB_REACH_PX
    const measure = (): void => {
      const rows = Array.from(secondPane.querySelectorAll(TAB_ROW_SELECTOR), (row) =>
        row.getBoundingClientRect()
      )
      const next = getThinSeamGrabSegments(handle.getBoundingClientRect(), rows, reachPx)
      setSegments((previous) => (previous && sameGrabSegments(previous, next) ? previous : next))
    }
    measure()
    // Why: an inner split moving a row always resizes the groups around it; the handle covers outer resizes.
    const observer = new ResizeObserver(measure)
    observer.observe(handle)
    for (const row of secondPane.querySelectorAll(TAB_ROW_SELECTOR)) {
      if (row.parentElement) {
        observer.observe(row.parentElement)
      }
    }
    return () => observer.disconnect()
  }, [enabled, handleRef, layoutKey])
  return segments
}

export function ResizeHandle({
  direction,
  thin = false,
  avoidTabRows = false,
  layoutKey,
  onResizeStart,
  onResizeEnd,
  onRatioChange
}: {
  direction: 'horizontal' | 'vertical'
  /** A 1px line with an invisible wider grab area instead of the compact 6px gutter (DevTools docks keep 6px). */
  thin?: boolean
  /** Vertical thin seams: keep the grab area off attached tab rows on the right, so tabs keep their presses. */
  avoidTabRows?: boolean
  /** Changes when the layout beside the seam changes, so tab rows are found again. */
  layoutKey?: unknown
  onResizeStart: () => void
  onResizeEnd?: () => void
  onRatioChange: (ratio: number) => void
}): React.JSX.Element {
  const isHorizontal = direction === 'horizontal'
  const [dragging, setDragging] = useState(false)
  const handleRef = useRef<HTMLDivElement>(null)
  const activeResizeCleanupRef = useRef<((updateDragging?: boolean) => void) | null>(null)

  useEffect(
    () => () => {
      activeResizeCleanupRef.current?.(false)
    },
    []
  )

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault()
      // Why: a second pointer must not steal or finalize the active gesture.
      if (activeResizeCleanupRef.current) {
        return
      }
      const handle = event.currentTarget
      const container = handle.parentElement
      if (!container) {
        return
      }
      const firstPane = handle.previousElementSibling as HTMLElement | null
      const secondPane = handle.nextElementSibling as HTMLElement | null
      if (!firstPane || !secondPane) {
        return
      }
      onResizeStart()
      setDragging(true)
      handle.setPointerCapture(event.pointerId)
      // Why: a guest page under the first move takes the gesture before capture activates; keep guests click-through.
      const releaseWebviewDragPassthrough = acquireWebviewsDragPassthrough()
      const startRect = container.getBoundingClientRect()
      const handleRect = handle.getBoundingClientRect()
      const handleSize = isHorizontal ? handleRect.width : handleRect.height
      const startPos = isHorizontal ? event.clientX : event.clientY
      const startRatio =
        readSplitRatio(firstPane, secondPane) ??
        measureSplitRatio(firstPane, secondPane, isHorizontal)
      let draggedRatio: number | null = null

      const followPointer = (pointerEvent: PointerEvent): void => {
        // Why: read the container each event so a mid-drag move or resize (sidebar, window, dock) keeps the seam under the pointer.
        const rect = container.getBoundingClientRect()
        const clamped = getDraggedSplitRatio({
          startRatio,
          startPos,
          pos: isHorizontal ? pointerEvent.clientX : pointerEvent.clientY,
          startContainerPos: isHorizontal ? startRect.left : startRect.top,
          containerPos: isHorizontal ? rect.left : rect.top,
          startAvailablePx: (isHorizontal ? startRect.width : startRect.height) - handleSize,
          availablePx: (isHorizontal ? rect.width : rect.height) - handleSize
        })
        if (clamped === null) {
          return
        }
        draggedRatio = clamped
        // Write pane styles during drag to avoid 60–120 global store updates per second; commit once on release.
        firstPane.style.flex = `${clamped} 1 0%`
        secondPane.style.flex = `${1 - clamped} 1 0%`
      }

      const onPointerMove = (moveEvent: PointerEvent): void => {
        // Why: Linux Chromium delivers pointermove while hasPointerCapture() reports false; own by pointerId only.
        if (moveEvent.pointerId !== event.pointerId) {
          return
        }
        // Why: a release outside the window can arrive as a buttonless move instead of pointerup.
        if (moveEvent.buttons === 0) {
          cleanup()
          return
        }
        followPointer(moveEvent)
      }

      let cleaned = false
      const cleanup = (updateDragging = true): void => {
        if (cleaned) {
          return
        }
        cleaned = true
        releaseWebviewDragPassthrough()
        onResizeEnd?.()
        if (draggedRatio !== null) {
          onRatioChange(draggedRatio)
        }
        if (updateDragging) {
          setDragging(false)
        }
        try {
          if (handle.hasPointerCapture(event.pointerId)) {
            handle.releasePointerCapture(event.pointerId)
          }
        } catch {
          // Best effort: unmount cleanup can run after Chromium has already dropped capture.
        }
        window.removeEventListener('pointermove', onPointerMove)
        window.removeEventListener('pointerup', onPointerUp)
        window.removeEventListener('pointercancel', onPointerCancel)
        handle.removeEventListener('lostpointercapture', onLostPointerCapture)
        window.removeEventListener('blur', onWindowBlur)
        document.removeEventListener('visibilitychange', onVisibilityChange)
        window.removeEventListener('pointerdown', onNextPointerDown, true)
        if (activeResizeCleanupRef.current === cleanup) {
          activeResizeCleanupRef.current = null
        }
      }

      const onPointerUp = (upEvent: PointerEvent): void => {
        if (upEvent.pointerId !== event.pointerId) {
          return
        }
        // Why: the layout may have shifted since the last move; commit where the pointer actually released.
        if (draggedRatio !== null) {
          followPointer(upEvent)
        }
        cleanup()
      }

      const onPointerCancel = (cancelEvent: PointerEvent): void => {
        if (cancelEvent.pointerId === event.pointerId) {
          cleanup()
        }
      }

      const onLostPointerCapture = (lostEvent: PointerEvent): void => {
        if (lostEvent.pointerId === event.pointerId) {
          cleanup()
        }
      }

      // Why: a release outside a blurred or hidden window may never arrive; end the gesture so guests take input again.
      const onWindowBlur = (): void => cleanup()
      // Why: a new press of the same pointer anywhere proves the old release was missed; end it before the press is handled.
      const onNextPointerDown = (downEvent: PointerEvent): void => {
        if (downEvent.pointerId === event.pointerId) {
          cleanup()
        }
      }
      const onVisibilityChange = (): void => {
        if (document.visibilityState === 'hidden') {
          cleanup()
        }
      }

      window.addEventListener('pointermove', onPointerMove)
      window.addEventListener('pointerup', onPointerUp)
      window.addEventListener('pointercancel', onPointerCancel)
      handle.addEventListener('lostpointercapture', onLostPointerCapture)
      window.addEventListener('blur', onWindowBlur)
      document.addEventListener('visibilitychange', onVisibilityChange)
      window.addEventListener('pointerdown', onNextPointerDown, true)
      activeResizeCleanupRef.current = cleanup
    },
    [isHorizontal, onRatioChange, onResizeStart, onResizeEnd]
  )

  const tabRowSegments = useTabRowGrabSegments(
    handleRef,
    thin && isHorizontal && avoidTabRows,
    layoutKey
  )
  // Horizontal seams reach up, away from the tab strip below, so they need no gaps.
  const grabSegments: React.CSSProperties[] | null = !thin ? null : (tabRowSegments ?? WHOLE_SEAM)

  return (
    <div
      ref={handleRef}
      className={`tab-group-split-resize-handle ${
        isHorizontal ? 'is-vertical' : 'is-horizontal'
      }${thin ? ' is-thin' : ''}${dragging ? ' is-dragging' : ''}`}
      onPointerDown={onPointerDown}
    >
      {grabSegments?.map((style, index) => (
        <div key={index} className="tab-group-split-grab" style={style} />
      ))}
    </div>
  )
}
