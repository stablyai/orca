const PRIMARY_POINTER_BUTTON_MASK = 1

export type HeaderDragPointerSession = {
  pointerId: number
  pointerType: string
  aliasedPointerId: number | null
}

/** Match pointermove for an active header drag, adopting WSLg/X11 mouse-to-pen pointer handoffs. */
export function matchesHeaderDragPointerMove(
  session: HeaderDragPointerSession,
  event: Pick<PointerEvent, 'pointerId' | 'pointerType' | 'buttons'>
): boolean {
  if (event.pointerId === session.pointerId) {
    return true
  }
  if (session.aliasedPointerId !== null) {
    return event.pointerId === session.aliasedPointerId
  }
  if (
    session.pointerType === 'mouse' &&
    event.pointerType === 'pen' &&
    (event.buttons & PRIMARY_POINTER_BUTTON_MASK) !== 0
  ) {
    session.aliasedPointerId = event.pointerId
    return true
  }
  return false
}

export function matchesHeaderDragPointerEnd(
  session: HeaderDragPointerSession,
  event: Pick<PointerEvent, 'pointerId'>
): boolean {
  return (
    event.pointerId === session.pointerId ||
    (session.aliasedPointerId !== null && event.pointerId === session.aliasedPointerId)
  )
}
