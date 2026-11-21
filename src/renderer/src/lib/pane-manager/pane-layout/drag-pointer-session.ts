/** Pointer identity and capture release shared by every pane drag. Both rules are
 *  Electron/Chromium workarounds that each drag site otherwise has to rediscover. */

export type ActiveDragPointer = { pointerId: number; pointerType: string }

type DragPointerEvent = { pointerId: number; isPrimary: boolean; pointerType: string }

/** Why the primary fallback: WSLg's RDP input path reports press and release as a
 *  `mouse` pointer but streams motion as a `pen` pointer with a different id, so
 *  strict id equality drops every move and the drag silently does nothing. */
export function matchesActiveDragPointer(
  active: ActiveDragPointer | null,
  event: DragPointerEvent
): boolean {
  if (active === null) {
    return false
  }
  return (
    event.pointerId === active.pointerId ||
    (event.isPrimary && event.pointerType !== 'touch' && active.pointerType !== 'touch')
  )
}

export function releasePointerCaptureIfHeld(
  element: Element | null,
  pointerId: number | null
): void {
  if (element === null || pointerId === null) {
    return
  }
  try {
    if (element.hasPointerCapture(pointerId)) {
      element.releasePointerCapture(pointerId)
    }
  } catch {
    // Best effort: capture may already be gone after crossing native chrome/webviews.
  }
}
