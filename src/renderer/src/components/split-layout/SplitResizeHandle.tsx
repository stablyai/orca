import { useCallback, useEffect, useRef, useState } from 'react'

// Shared drag-to-resize handle for the worktree-level split layout, mirroring
// the tab-group split handle so both layers resize identically. Pointer-capture
// logic is layout-agnostic; the only coupling is the onRatioChange callback.
// (TabGroupSplitLayout still holds an equivalent local copy — migrating it here
// is a deferred DRY cleanup, kept separate to avoid touching that file now.)

export const SPLIT_MIN_RATIO = 0.15
export const SPLIT_MAX_RATIO = 0.85

export function SplitResizeHandle({
  direction,
  onResizeStart,
  onRatioChange
}: {
  direction: 'horizontal' | 'vertical'
  onResizeStart: () => void
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
      const handle = event.currentTarget
      const container = handle.parentElement
      if (!container) {
        return
      }
      activeResizeCleanupRef.current?.()
      onResizeStart()
      setDragging(true)
      handle.setPointerCapture(event.pointerId)

      const onPointerMove = (moveEvent: PointerEvent): void => {
        if (!handle.hasPointerCapture(event.pointerId)) {
          return
        }
        const rect = container.getBoundingClientRect()
        const ratio = isHorizontal
          ? (moveEvent.clientX - rect.left) / rect.width
          : (moveEvent.clientY - rect.top) / rect.height
        onRatioChange(Math.min(SPLIT_MAX_RATIO, Math.max(SPLIT_MIN_RATIO, ratio)))
      }

      let cleaned = false
      const cleanup = (updateDragging = true): void => {
        if (cleaned) {
          return
        }
        cleaned = true
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

      const onPointerUp = (): void => {
        cleanup()
      }

      const onPointerCancel = (): void => {
        cleanup()
      }

      const onLostPointerCapture = (): void => {
        cleanup()
      }

      handle.addEventListener('pointermove', onPointerMove)
      handle.addEventListener('pointerup', onPointerUp)
      handle.addEventListener('pointercancel', onPointerCancel)
      handle.addEventListener('lostpointercapture', onLostPointerCapture)
      activeResizeCleanupRef.current = cleanup
    },
    [isHorizontal, onRatioChange, onResizeStart]
  )

  return (
    <div
      className={`tab-group-split-resize-handle ${
        isHorizontal ? 'is-vertical' : 'is-horizontal'
      }${dragging ? ' is-dragging' : ''}`}
      onPointerDown={onPointerDown}
    />
  )
}
