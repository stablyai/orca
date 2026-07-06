import { useCallback, useEffect, useRef } from 'react'
import { TAB_DRAG_ACTIVATION_DISTANCE_PX } from '../tab-group/useTabDragSplit'
import { beginTabStripPointerGesture } from './tab-strip-pointer-gesture'
import type { TabStripSelectionModifiers } from './tab-strip-selection'

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
export function useTabStripPointerActivation({
  onActivate,
  disabled = false
}: {
  onActivate: (modifiers: TabStripSelectionModifiers) => void
  disabled?: boolean
}): {
  onPointerDown: (
    event: React.PointerEvent,
    dragListener?: (event: React.PointerEvent<Element>) => void
  ) => void
  onClick: (event: React.MouseEvent) => void
} {
  const onActivateRef = useRef(onActivate)
  onActivateRef.current = onActivate
  const cleanupRef = useRef<(() => void) | null>(null)
  const pendingClickModifiersRef = useRef<TabStripSelectionModifiers | null>(null)
  const clickActivationReadyRef = useRef(false)
  const heldModifiersRef = useRef<TabStripSelectionModifiers>({
    shiftKey: false,
    metaKey: false,
    ctrlKey: false
  })
  const recentModifierRef = useRef({
    shiftDownAt: 0,
    shiftUpAt: 0,
    metaDownAt: 0,
    metaUpAt: 0,
    ctrlDownAt: 0,
    ctrlUpAt: 0
  })

  // Why: a press still holding when the tab unmounts (tab closed mid-drag, group
  // collapse) would otherwise leak its window listeners and later fire activation
  // on a dead closure.
  useEffect(() => () => cleanupRef.current?.(), [])
  useEffect(() => {
    const updateHeldModifiers = (event: KeyboardEvent): void => {
      heldModifiersRef.current = {
        shiftKey: event.shiftKey,
        metaKey: event.metaKey,
        ctrlKey: event.ctrlKey
      }
      const now = Date.now()
      if (event.type === 'keydown') {
        if (event.key === 'Shift' || event.shiftKey) {
          recentModifierRef.current.shiftDownAt = now
        }
        if (event.key === 'Meta' || event.metaKey) {
          recentModifierRef.current.metaDownAt = now
        }
        if (event.key === 'Control' || event.ctrlKey) {
          recentModifierRef.current.ctrlDownAt = now
        }
      } else {
        if (event.key === 'Shift' || !event.shiftKey) {
          recentModifierRef.current.shiftUpAt = now
        }
        if (event.key === 'Meta' || !event.metaKey) {
          recentModifierRef.current.metaUpAt = now
        }
        if (event.key === 'Control' || !event.ctrlKey) {
          recentModifierRef.current.ctrlUpAt = now
        }
      }
    }
    const clearHeldModifiers = (): void => {
      heldModifiersRef.current = {
        shiftKey: false,
        metaKey: false,
        ctrlKey: false
      }
    }
    window.addEventListener('keydown', updateHeldModifiers, true)
    window.addEventListener('keyup', updateHeldModifiers, true)
    window.addEventListener('blur', clearHeldModifiers)
    return () => {
      window.removeEventListener('keydown', updateHeldModifiers, true)
      window.removeEventListener('keyup', updateHeldModifiers, true)
      window.removeEventListener('blur', clearHeldModifiers)
    }
  }, [])

  const onPointerDown = useCallback(
    (event: React.PointerEvent, dragListener?: (event: React.PointerEvent<Element>) => void) => {
      if (disabled || event.button !== 0) {
        return
      }
      // Why: start the dnd-kit gesture immediately on pointerdown; only the
      // activation decision is deferred to release.
      dragListener?.(event)

      cleanupRef.current?.()
      clickActivationReadyRef.current = false
      const startX = event.clientX
      const startY = event.clientY
      const startModifiers = {
        shiftKey: event.shiftKey || heldModifiersRef.current.shiftKey,
        metaKey: event.metaKey || heldModifiersRef.current.metaKey,
        ctrlKey: event.ctrlKey || heldModifiersRef.current.ctrlKey
      }
      const releaseTabStripPointerGesture = beginTabStripPointerGesture()

      const cleanup = (): void => {
        window.removeEventListener('pointerup', onPointerUp)
        window.removeEventListener('pointercancel', onPointerCancel)
        window.removeEventListener('blur', onPointerCancel)
        window.removeEventListener('focus', onPointerCancel)
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
        if (wasDrag) {
          clickActivationReadyRef.current = false
          pendingClickModifiersRef.current = null
        } else {
          clickActivationReadyRef.current = true
          pendingClickModifiersRef.current = {
            shiftKey: startModifiers.shiftKey || upEvent.shiftKey,
            metaKey: startModifiers.metaKey || upEvent.metaKey,
            ctrlKey: startModifiers.ctrlKey || upEvent.ctrlKey
          }
        }
      }
      const onPointerCancel = (): void => {
        clickActivationReadyRef.current = false
        pendingClickModifiersRef.current = null
        cleanup()
      }

      window.addEventListener('pointerup', onPointerUp)
      window.addEventListener('pointercancel', onPointerCancel)
      window.addEventListener('blur', onPointerCancel)
      window.addEventListener('focus', onPointerCancel)
      cleanupRef.current = cleanup
    },
    [disabled]
  )

  const onClick = useCallback(
    (event: React.MouseEvent): void => {
      if (disabled) {
        return
      }
      if (!clickActivationReadyRef.current) {
        pendingClickModifiersRef.current = null
        return
      }
      clickActivationReadyRef.current = false
      const pendingModifiers = pendingClickModifiersRef.current
      pendingClickModifiersRef.current = null
      // Why: the element-level click event is the most reliable modifier source
      // for manual Electron clicks; pointerup still contributes press/release
      // modifiers for edge cases where click drops them.
      onActivateRef.current({
        shiftKey:
          event.shiftKey ||
          pendingModifiers?.shiftKey === true ||
          heldModifiersRef.current.shiftKey ||
          isRecentModifierDown(
            recentModifierRef.current.shiftDownAt,
            recentModifierRef.current.shiftUpAt
          ),
        metaKey:
          event.metaKey ||
          pendingModifiers?.metaKey === true ||
          heldModifiersRef.current.metaKey ||
          isRecentModifierDown(
            recentModifierRef.current.metaDownAt,
            recentModifierRef.current.metaUpAt
          ),
        ctrlKey:
          event.ctrlKey ||
          pendingModifiers?.ctrlKey === true ||
          heldModifiersRef.current.ctrlKey ||
          isRecentModifierDown(
            recentModifierRef.current.ctrlDownAt,
            recentModifierRef.current.ctrlUpAt
          )
      })
    },
    [disabled]
  )

  return { onPointerDown, onClick }
}

function isRecentModifierDown(downAt: number, upAt: number): boolean {
  // Why: focus churn can drop the modifier state before click; 3s recovers the
  // intended click while keeping the false-positive window short.
  return downAt > upAt && Date.now() - downAt <= 3000
}
