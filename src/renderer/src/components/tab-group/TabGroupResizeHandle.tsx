import { useCallback, useEffect, useRef, useState } from 'react'

const MIN_RATIO = 0.15
const MAX_RATIO = 0.85

export function TabGroupResizeHandle({
  direction,
  onResizeStart,
  onResizeEnd,
  onRatioChange,
  onRatioPreview,
  ratio = 0.5,
  label
}: {
  direction: 'horizontal' | 'vertical'
  onResizeStart: () => void
  onResizeEnd?: () => void
  onRatioChange: (ratio: number) => void
  onRatioPreview?: (ratio: number) => void
  ratio?: number
  label?: string
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
      const firstPane = handle.previousElementSibling
      const secondPane = handle.nextElementSibling
      if (!(firstPane instanceof HTMLElement) || !(secondPane instanceof HTMLElement)) {
        return
      }
      onResizeStart()
      setDragging(true)
      handle.setPointerCapture(event.pointerId)
      // Why: measure outside pointermove so pane writes never force a readback.
      let rect = container.getBoundingClientRect()
      const resizeObserver = new ResizeObserver(() => {
        rect = container.getBoundingClientRect()
      })
      resizeObserver.observe(container)
      let draggedRatio: number | null = null

      const onPointerMove = (moveEvent: PointerEvent): void => {
        if (moveEvent.pointerId !== event.pointerId || !handle.hasPointerCapture(event.pointerId)) {
          return
        }
        const ratio = isHorizontal
          ? (moveEvent.clientX - rect.left) / rect.width
          : (moveEvent.clientY - rect.top) / rect.height
        const clamped = Math.min(MAX_RATIO, Math.max(MIN_RATIO, ratio))
        draggedRatio = clamped
        // Why: direct style writes keep the drag off the store — a commit per
        // pointermove published 60-120 global store updates/s against every
        // subscriber (STA-3328). React re-applies identical flex on commit.
        firstPane.style.flex = `${clamped} 1 0%`
        secondPane.style.flex = `${1 - clamped} 1 0%`
        onRatioPreview?.(clamped)
      }

      let cleaned = false
      const cleanup = (updateDragging = true): void => {
        if (cleaned) {
          return
        }
        cleaned = true
        resizeObserver.disconnect()
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
        handle.removeEventListener('pointermove', onPointerMove)
        handle.removeEventListener('pointerup', onPointerUp)
        handle.removeEventListener('pointercancel', onPointerCancel)
        handle.removeEventListener('lostpointercapture', onLostPointerCapture)
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

      handle.addEventListener('pointermove', onPointerMove)
      handle.addEventListener('pointerup', onPointerUp)
      handle.addEventListener('pointercancel', onPointerCancel)
      handle.addEventListener('lostpointercapture', onLostPointerCapture)
      activeResizeCleanupRef.current = cleanup
    },
    [isHorizontal, onRatioChange, onRatioPreview, onResizeStart, onResizeEnd]
  )

  return (
    <div
      className={`tab-group-split-resize-handle pointer-events-auto ${
        isHorizontal ? 'is-vertical' : 'is-horizontal'
      }${dragging ? ' is-dragging' : ''}`}
      onPointerDown={onPointerDown}
      role={label ? 'separator' : undefined}
      aria-label={label}
      aria-orientation={label ? (isHorizontal ? 'vertical' : 'horizontal') : undefined}
      aria-valuemin={label ? 15 : undefined}
      aria-valuemax={label ? 85 : undefined}
      aria-valuenow={label ? Math.round(ratio * 100) : undefined}
      tabIndex={label ? 0 : undefined}
      onKeyDown={
        label
          ? (event) => {
              const decrease = isHorizontal ? 'ArrowLeft' : 'ArrowUp'
              const increase = isHorizontal ? 'ArrowRight' : 'ArrowDown'
              if (event.key !== decrease && event.key !== increase && event.key !== 'Home') {
                return
              }
              event.preventDefault()
              onRatioChange(
                event.key === 'Home'
                  ? 0.5
                  : Math.max(
                      MIN_RATIO,
                      Math.min(MAX_RATIO, ratio + (event.key === decrease ? -0.02 : 0.02))
                    )
              )
            }
          : undefined
      }
    />
  )
}
