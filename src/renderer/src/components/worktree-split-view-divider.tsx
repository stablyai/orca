import { useCallback, useEffect, useRef, useState } from 'react'
import {
  clampWorktreeSplitViewRatio,
  WORKTREE_SPLIT_LEFT_FLEX_VAR
} from '../store/slices/worktree-split-view'

/** The draggable seam between the two worktrees of a split view. */
export function WorktreeSplitViewDivider({
  onRatioCommit
}: {
  onRatioCommit: (ratio: number) => void
}): React.JSX.Element {
  const [dragging, setDragging] = useState(false)
  const activeCleanupRef = useRef<((commit: boolean) => void) | null>(null)

  useEffect(
    () => () => {
      activeCleanupRef.current?.(false)
    },
    []
  )

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault()
      if (activeCleanupRef.current) {
        return
      }
      const handle = event.currentTarget
      const container = handle.parentElement
      if (!container) {
        return
      }
      setDragging(true)
      handle.setPointerCapture(event.pointerId)
      const rect = container.getBoundingClientRect()
      let draggedRatio: number | null = null

      const onPointerMove = (moveEvent: PointerEvent): void => {
        if (moveEvent.pointerId !== event.pointerId || rect.width <= 0) {
          return
        }
        draggedRatio = clampWorktreeSplitViewRatio((moveEvent.clientX - rect.left) / rect.width)
        // Why: a store write per pointermove would re-render every surface subscriber.
        container.style.setProperty(WORKTREE_SPLIT_LEFT_FLEX_VAR, String(draggedRatio))
      }
      const cleanup = (commit: boolean): void => {
        activeCleanupRef.current = null
        handle.removeEventListener('pointermove', onPointerMove)
        handle.removeEventListener('pointerup', onPointerEnd)
        handle.removeEventListener('pointercancel', onPointerEnd)
        handle.removeEventListener('lostpointercapture', onPointerEnd)
        try {
          if (handle.hasPointerCapture(event.pointerId)) {
            handle.releasePointerCapture(event.pointerId)
          }
        } catch {
          // Best effort: unmount cleanup can run after Chromium already dropped capture.
        }
        if (commit) {
          setDragging(false)
          if (draggedRatio !== null) {
            onRatioCommit(draggedRatio)
          }
        }
      }
      const onPointerEnd = (endEvent: PointerEvent): void => {
        if (endEvent.pointerId === event.pointerId) {
          cleanup(true)
        }
      }
      handle.addEventListener('pointermove', onPointerMove)
      handle.addEventListener('pointerup', onPointerEnd)
      handle.addEventListener('pointercancel', onPointerEnd)
      handle.addEventListener('lostpointercapture', onPointerEnd)
      activeCleanupRef.current = cleanup
    },
    [onRatioCommit]
  )

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      className={
        dragging
          ? 'tab-group-split-resize-handle is-vertical is-dragging order-1'
          : 'tab-group-split-resize-handle is-vertical order-1'
      }
      onPointerDown={onPointerDown}
    />
  )
}
