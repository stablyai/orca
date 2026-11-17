import { useCallback, useEffect, useRef, useState } from 'react'
import { acquireWebviewsDragPassthrough } from '../browser-pane/host-guest/drag/webview-drag-passthrough'
import { DIVIDER_HIT_PX } from '@/lib/divider-hit-area'
import { getDraggedSplitRatio, measureSplitRatio, readSplitRatio } from './pane-split-drag-ratio'

type WideHandleStyle = React.CSSProperties & Record<`--${string}`, string>
// Why: the line reaches the center of a perpendicular parent gap so split T-junctions connect.
const LINE_EXTENSION = `${DIVIDER_HIT_PX / 2}px`
const WIDE_VERTICAL_STYLE: WideHandleStyle = {
  width: DIVIDER_HIT_PX,
  '--divider-extension': LINE_EXTENSION
}
const WIDE_HORIZONTAL_STYLE: WideHandleStyle = {
  height: DIVIDER_HIT_PX,
  '--divider-extension': LINE_EXTENSION
}

export function ResizeHandle({
  direction,
  wide = false,
  tabBand = false,
  onResizeStart,
  onResizeEnd,
  onRatioChange
}: {
  direction: 'horizontal' | 'vertical'
  /** Use the shared in-flow grab size instead of the compact 6px gutter (DevTools docks keep 6px). */
  wide?: boolean
  /** The gap's top edge sits beside attached tab strips, so it continues their band. */
  tabBand?: boolean
  onResizeStart: () => void
  onResizeEnd?: () => void
  onRatioChange: (ratio: number) => void
}): React.JSX.Element {
  const isHorizontal = direction === 'horizontal'
  const [dragging, setDragging] = useState(false)
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

  return (
    <div
      className={`tab-group-split-resize-handle ${
        isHorizontal ? 'is-vertical' : 'is-horizontal'
      }${wide ? ' is-wide' : ''}${tabBand ? ' has-tab-band' : ''}${dragging ? ' is-dragging' : ''}`}
      style={wide ? (isHorizontal ? WIDE_VERTICAL_STYLE : WIDE_HORIZONTAL_STYLE) : undefined}
      onPointerDown={onPointerDown}
    />
  )
}
