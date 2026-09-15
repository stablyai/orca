import { useCallback, useEffect, useRef } from 'react'
import { TAB_DRAG_ACTIVATION_DISTANCE_PX } from '../tab-group/useTabDragSplit'
import { beginTabStripPointerGesture } from './tab-strip-pointer-gesture'

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
 * mirrors dnd-kit's own activation threshold, but the authority is the release
 * position. A release within it is a click (activate); a release outside it is a
 * drag (activation suppressed). Because each press measures its own gesture, a
 * click after a reorder always activates.
 */
/** Whether an in-page guest (a `<webview>`) currently owns the keyboard, which blurs the embedder. */
function isGuestHoldingKeyboard(doc?: Document | null): boolean {
  const currentDoc = doc ?? (typeof document !== 'undefined' ? document : null)
  return currentDoc?.activeElement?.tagName === 'WEBVIEW'
}

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
      const targetNode = event.target as Node | null
      const targetWindow = targetNode?.ownerDocument?.defaultView ?? window
      const releaseTabStripPointerGesture = beginTabStripPointerGesture()
      // Why a press that starts under a guest forgives one window focus: an in-page <webview>
      // holding the keyboard leaves the embedder blurred, so this very press is what pulls focus
      // back and #7316's flush would eat the click that takes the reader out of a browser pane.
      // Why one more when the press lands in an unfocused auxiliary window: that press also
      // pulls focus (popout gain), and dual-window bookkeeping would flush the legit click.
      const targetWindowSettled =
        targetWindow === window ? true : (targetWindow.document.hasFocus?.() ?? true)
      let pendingFocusForgiveness =
        (targetWindowSettled ? 0 : 1) + (isGuestHoldingKeyboard(targetNode?.ownerDocument) ? 1 : 0)

      const cleanup = (): void => {
        targetWindow.removeEventListener('pointerup', onPointerUp)
        targetWindow.removeEventListener('pointercancel', onPointerCancel)
        targetWindow.removeEventListener('blur', onPointerCancel)
        targetWindow.removeEventListener('focus', onWindowFocus)
        if (targetWindow !== window) {
          window.removeEventListener('pointerup', onPointerUp)
          window.removeEventListener('pointercancel', onPointerCancel)
        }
        releaseTabStripPointerGesture()
        cleanupRef.current = null
      }
      const onPointerUp = (upEvent: PointerEvent): void => {
        const wasDrag =
          Math.hypot(upEvent.clientX - startX, upEvent.clientY - startY) >=
          TAB_DRAG_ACTIVATION_DISTANCE_PX
        cleanup()
        // Why: packaged Chromium can deliver a stale first pointermove after
        // focus; the final release position is the click/drag authority.
        if (!wasDrag) {
          onActivateRef.current()
        }
      }
      const onPointerCancel = (): void => {
        cleanup()
      }
      const onWindowFocus = (): void => {
        if (pendingFocusForgiveness > 0) {
          pendingFocusForgiveness -= 1
          return
        }
        cleanup()
      }
      targetWindow.addEventListener('pointerup', onPointerUp)
      targetWindow.addEventListener('pointercancel', onPointerCancel)
      targetWindow.addEventListener('blur', onPointerCancel)
      targetWindow.addEventListener('focus', onWindowFocus)
      if (targetWindow !== window) {
        // Why: release can land in either window, but focus/blur stay on the
        // press window so the other window's bookkeeping never flushes the click.
        window.addEventListener('pointerup', onPointerUp)
        window.addEventListener('pointercancel', onPointerCancel)
      }
      cleanupRef.current = cleanup
    },
    [disabled]
  )

  return { onPointerDown }
}
