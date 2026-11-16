import { useCallback, useEffect, useRef, useState } from 'react'
import { acquireWebviewsDragPassthrough } from '../browser-pane/host-guest/drag/webview-drag-passthrough'
import { getDividerFarOverhangPx, installDividerNativeDragGuard } from '@/lib/divider-hit-area'
import { getDraggedSplitRatio, measureSplitRatio, readSplitRatio } from './pane-split-drag-ratio'

// Matches the .tab-group-split-resize-handle box in main.css.
const HANDLE_THICKNESS_PX = 6

export function ResizeHandle({
  direction,
  growHitArea = false,
  onResizeStart,
  onResizeEnd,
  onRatioChange
}: {
  direction: 'horizontal' | 'vertical'
  /** Widen the grab area over the second pane (away from the first pane's scrollbar) to the shared size. */
  growHitArea?: boolean
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

  useEffect(() => {
    if (growHitArea) {
      installDividerNativeDragGuard()
    }
  }, [growHitArea])

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
      // Why: measure outside pointermove so pane writes never force a readback.
      let rect = container.getBoundingClientRect()
      const handleRect = handle.getBoundingClientRect()
      const handleSize = isHorizontal ? handleRect.width : handleRect.height
      const startPos = isHorizontal ? event.clientX : event.clientY
      const startRatio =
        readSplitRatio(firstPane, secondPane) ??
        measureSplitRatio(firstPane, secondPane, isHorizontal)
      const resizeObserver = new ResizeObserver(() => {
        rect = container.getBoundingClientRect()
      })
      resizeObserver.observe(container)
      let draggedRatio: number | null = null

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
        // Why: follow the pointer's displacement, not its absolute position, so an off-center grab never jumps.
        const clamped = getDraggedSplitRatio({
          startRatio,
          startPos,
          pos: isHorizontal ? moveEvent.clientX : moveEvent.clientY,
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

      let cleaned = false
      const cleanup = (updateDragging = true): void => {
        if (cleaned) {
          return
        }
        cleaned = true
        resizeObserver.disconnect()
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
        if (upEvent.pointerId === event.pointerId) {
          cleanup()
        }
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
      }${growHitArea ? ' has-far-overhang' : ''}${dragging ? ' is-dragging' : ''}`}
      style={
        growHitArea
          ? ({
              '--divider-far-overhang': `${getDividerFarOverhangPx(HANDLE_THICKNESS_PX)}px`
            } as React.CSSProperties)
          : undefined
      }
      onPointerDown={onPointerDown}
    />
  )
}
