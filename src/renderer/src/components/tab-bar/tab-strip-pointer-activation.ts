import { useCallback, useEffect, useRef } from 'react'
import { TAB_DRAG_ACTIVATION_DISTANCE_PX } from '../tab-group/useTabDragSplit'

/**
 * Defer tab activation to pointer-up and suppress it when the press turns into a
 * drag. PR #5927 shipped this so dragging a tab (to reorder, move into another
 * pane, or split) never switched the active tab or stole terminal focus
 * mid-gesture; #6395 removed it (activating eagerly on pointerdown) to fix
 * click-to-switch-after-reorder, which regressed the drag feature.
 *
 * We gate on measured pointer DISPLACEMENT, not the drag-active context ref the
 * old hook used — that ref clears asynchronously relative to the drop's
 * pointerup, which is what made #6395's click-after-reorder misfire. Displacement
 * mirrors dnd-kit's own activation threshold exactly: once the pointer travels
 * past it the gesture is a drag (activation suppressed); a release within it is a
 * click (activate). Because each press measures its own gesture, a click after a
 * reorder always activates.
 */
export function useTabStripPointerActivation({
  onActivate,
  disabled = false
}: {
  onActivate: () => void
  disabled?: boolean
}): {
  onPointerDown: (
    event: React.PointerEvent,
    dragListener?: (event: React.PointerEvent<Element>) => void
  ) => void
} {
  const onActivateRef = useRef(onActivate)
  onActivateRef.current = onActivate
  const cleanupRef = useRef<(() => void) | null>(null)

  // Why: a press still holding when the tab unmounts (tab closed mid-drag, group
  // collapse) would otherwise leak its window listeners and later fire activation
  // on a dead closure.
  useEffect(() => () => cleanupRef.current?.(), [])

  const onPointerDown = useCallback(
    (event: React.PointerEvent, dragListener?: (event: React.PointerEvent<Element>) => void) => {
      if (disabled || event.button !== 0) {
        return
      }
      // Why: start the dnd-kit gesture immediately on pointerdown; only the
      // activation decision is deferred to release.
      dragListener?.(event)

      cleanupRef.current?.()
      const startX = event.clientX
      const startY = event.clientY
      let draggedPastThreshold = false

      const cleanup = (): void => {
        window.removeEventListener('pointermove', onPointerMove)
        window.removeEventListener('pointerup', onPointerUp)
        window.removeEventListener('pointercancel', onPointerCancel)
        cleanupRef.current = null
      }
      const onPointerMove = (moveEvent: PointerEvent): void => {
        if (
          Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY) >=
          TAB_DRAG_ACTIVATION_DISTANCE_PX
        ) {
          draggedPastThreshold = true
        }
      }
      const onPointerUp = (): void => {
        const wasDrag = draggedPastThreshold
        cleanup()
        // Why: only a release that never crossed the drag threshold is a click.
        // Activating after a real drag would yank the just-dropped tab's pane
        // back to the source selection.
        if (!wasDrag) {
          onActivateRef.current()
        }
      }
      const onPointerCancel = (): void => {
        cleanup()
      }

      window.addEventListener('pointermove', onPointerMove)
      window.addEventListener('pointerup', onPointerUp)
      window.addEventListener('pointercancel', onPointerCancel)
      cleanupRef.current = cleanup
    },
    [disabled]
  )

  return { onPointerDown }
}
