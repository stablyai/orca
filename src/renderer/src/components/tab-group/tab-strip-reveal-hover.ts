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
    const evaluate = (clientX: number, clientY: number): void => {
      const panel = panelRef.current
      if (!panel) {
        return
      }
      const next = resolveTabStripRevealHover({
        panelRect: panel.getBoundingClientRect(),
        clientX,
        clientY,
        currentlyHovered: hovered
      })
      if (next !== hovered) {
        hovered = next
        onHoverChangeRef.current(next)
      }
    }
    const onPointerMove = (event: PointerEvent): void => {
      if (frame !== 0) {
        return
      }
      const { clientX, clientY } = event
      frame = requestAnimationFrame(() => {
        frame = 0
        evaluate(clientX, clientY)
      })
    }
    // Capture: a pane-detach drag stops propagation, and that drag is exactly when the strip is needed.
    window.addEventListener('pointermove', onPointerMove, true)
    return () => {
      window.removeEventListener('pointermove', onPointerMove, true)
      if (frame !== 0) {
        cancelAnimationFrame(frame)
      }
      // Why: the next enabled run restarts from `hovered = false`, so a reveal left latched here —
      // a worktree switched away mid-hover — would survive until the pointer re-crossed the zone.
      if (hovered) {
        onHoverChangeRef.current(false)
      }
    }
  }, [enabled, panelRef])
}
