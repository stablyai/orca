import { useCallback, useEffect, useRef } from 'react'
import { TAB_DRAG_ACTIVATION_DISTANCE_PX } from '../tab-group/useTabDragSplit'
import { beginTabStripPointerGesture } from './tab-strip-pointer-gesture'

/** Activate from release displacement, not asynchronously cleared drag state, so drags stay inactive and post-drag clicks still work. */
function isGuestHoldingKeyboard(): boolean {
  return typeof document !== 'undefined' && document.activeElement?.tagName === 'WEBVIEW'
}

export function useTabStripPointerActivation({
  onActivate,
  disabled = false
}: {
  onActivate: () => void
  disabled?: boolean
}): {
  retirePendingActivation: () => void
  onPointerDown: (
    event: React.PointerEvent,
    dragListener?: (event: React.PointerEvent<Element>) => void
  ) => void
} {
  const onActivateRef = useRef(onActivate)
  onActivateRef.current = onActivate
  const cleanupRef = useRef<(() => void) | null>(null)

  const retirePendingActivation = useCallback(() => cleanupRef.current?.(), [])

  // Retire window listeners on unmount so held presses cannot activate dead tabs.
  useEffect(() => () => cleanupRef.current?.(), [])

  const onPointerDown = useCallback(
    (event: React.PointerEvent, dragListener?: (event: React.PointerEvent<Element>) => void) => {
      if (disabled || event.button !== 0) {
        return
      }
      // Start dnd-kit immediately; defer only the tab activation decision.
      dragListener?.(event)

      cleanupRef.current?.()
      const startX = event.clientX
      const startY = event.clientY
      const releaseTabStripPointerGesture = beginTabStripPointerGesture()
      // Forgive one focus restoration when a press starts in a guest-blurred embedder; that press is leaving the guest.
      let pendingGuestFocusHandoff = isGuestHoldingKeyboard()

      const cleanup = (): void => {
        window.removeEventListener('pointerup', onPointerUp)
        window.removeEventListener('pointercancel', onPointerCancel)
        window.removeEventListener('contextmenu', onPointerCancel)
        window.removeEventListener('blur', onPointerCancel)
        window.removeEventListener('focus', onWindowFocus)
        releaseTabStripPointerGesture()
        cleanupRef.current = null
      }
      const onPointerUp = (upEvent: PointerEvent): void => {
        const wasDrag =
          Math.hypot(upEvent.clientX - startX, upEvent.clientY - startY) >=
          TAB_DRAG_ACTIVATION_DISTANCE_PX
        cleanup()
        // Use final release coordinates because packaged Chromium can deliver a stale first move after focus.
        if (!wasDrag) {
          onActivateRef.current()
        }
      }
      const onPointerCancel = (): void => {
        cleanup()
      }
      const onWindowFocus = (): void => {
        if (pendingGuestFocusHandoff) {
          pendingGuestFocusHandoff = false
          return
        }
        cleanup()
      }

      window.addEventListener('pointerup', onPointerUp)
      window.addEventListener('pointercancel', onPointerCancel)
      window.addEventListener('contextmenu', onPointerCancel)
      window.addEventListener('blur', onPointerCancel)
      window.addEventListener('focus', onWindowFocus)
      cleanupRef.current = cleanup
    },
    [disabled]
  )

  return { onPointerDown, retirePendingActivation }
}
