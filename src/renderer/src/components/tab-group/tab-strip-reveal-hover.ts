import { useEffect, useRef } from 'react'
import { TAB_GROUP_TAB_STRIP_HEIGHT_PX } from './tab-drop-zone'

/** How far below the group's top edge a pointer still counts as reaching for the collapsed strip. */
export const TAB_STRIP_REVEAL_HOVER_ZONE_PX = 30

export function resolveTabStripRevealHover({
  panelRect,
  clientX,
  clientY,
  currentlyHovered
}: {
  panelRect: { left: number; right: number; top: number }
  clientX: number
  clientY: number
  currentlyHovered: boolean
}): boolean {
  // Why: half-open on the right — a horizontal split puts its resize handle exactly on that
  // boundary, and hovering the divider must not reveal the panel's strip.
  if (clientX < panelRect.left || clientX >= panelRect.right) {
    return false
  }
  // Why: once open the strip itself must hold the hover, or a 30px zone would drop it mid-row.
  const zone = currentlyHovered
    ? Math.max(TAB_STRIP_REVEAL_HOVER_ZONE_PX, TAB_GROUP_TAB_STRIP_HEIGHT_PX)
    : TAB_STRIP_REVEAL_HOVER_ZONE_PX
  const offsetY = clientY - panelRect.top
  return offsetY >= 0 && offsetY < zone
}

/**
 * Watches the pointer for the top edge of a group whose strip is collapsed.
 *
 * Why window and not a sensor element: a sensor wide enough to feel right would swallow clicks on
 * the pane underneath, and pane-detach drags capture the pointer, so element enter/leave never fire.
 */
export function useTabStripRevealHover({
  enabled,
  panelRef,
  onHoverChange
}: {
  enabled: boolean
  panelRef: React.RefObject<HTMLElement | null>
  onHoverChange: (hovered: boolean) => void
}): void {
  const onHoverChangeRef = useRef(onHoverChange)
  onHoverChangeRef.current = onHoverChange

  useEffect(() => {
    if (!enabled) {
      return
    }
    let frame = 0
    let hovered = false
    let pointer: { clientX: number; clientY: number } | null = null
    const setHovered = (next: boolean): void => {
      if (next !== hovered) {
        hovered = next
        onHoverChangeRef.current(next)
      }
    }
    const cancelFrame = (): void => {
      if (frame !== 0) {
        cancelAnimationFrame(frame)
        frame = 0
      }
    }
    const evaluate = (): void => {
      const panel = panelRef.current
      if (!panel || !pointer) {
        return
      }
      setHovered(
        resolveTabStripRevealHover({
          panelRect: panel.getBoundingClientRect(),
          clientX: pointer.clientX,
          clientY: pointer.clientY,
          currentlyHovered: hovered
        })
      )
    }
    const onPointerMove = (event: PointerEvent): void => {
      // Why: keep the newest position — a high-rate mouse delivers several moves per frame, and
      // judging the first would leave the strip wherever the pointer merely passed through.
      pointer = { clientX: event.clientX, clientY: event.clientY }
      if (frame === 0) {
        frame = requestAnimationFrame(() => {
          frame = 0
          evaluate()
        })
      }
    }
    // Why: no pointermove reaches the window once the pointer has left it or the window lost
    // focus, so a strip revealed on the way out would stay open until the pointer came back.
    const onPointerLeftWindow = (event: PointerEvent): void => {
      if (event.relatedTarget === null) {
        cancelFrame()
        setHovered(false)
      }
    }
    const onWindowBlur = (): void => {
      cancelFrame()
      setHovered(false)
    }
    // Capture: a pane-detach drag stops propagation, and that drag is exactly when the strip is needed.
    window.addEventListener('pointermove', onPointerMove, true)
    window.addEventListener('pointerout', onPointerLeftWindow, true)
    window.addEventListener('blur', onWindowBlur)
    return () => {
      window.removeEventListener('pointermove', onPointerMove, true)
      window.removeEventListener('pointerout', onPointerLeftWindow, true)
      window.removeEventListener('blur', onWindowBlur)
      cancelFrame()
      // Why: the next enabled run restarts from `hovered = false`, so a reveal left latched here —
      // a worktree switched away mid-hover — would survive until the pointer re-crossed the zone.
      setHovered(false)
    }
  }, [enabled, panelRef])
}
