const PRIMARY_POINTER_BUTTON_MASK = 1

export type HeaderDragPointerSession = {
  pointerId: number
  pointerType: string
  aliasedPointerId: number | null
}

/** Match pointermove for an active header drag, adopting move-only WSLg/X11 mouse-to-pen handoffs. */
function matchesHeaderDragPointerMove(
  session: HeaderDragPointerSession,
  event: Pick<PointerEvent, 'pointerId' | 'pointerType' | 'buttons'>,
  ignoredPenPointerIds: ReadonlySet<number>
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
    !ignoredPenPointerIds.has(event.pointerId) &&
    (event.buttons & PRIMARY_POINTER_BUTTON_MASK) !== 0
  ) {
    session.aliasedPointerId = event.pointerId
    return true
  }
  return false
}

function matchesHeaderDragPointerEnd(
  session: HeaderDragPointerSession,
  event: Pick<PointerEvent, 'pointerId'>
): boolean {
  return (
    event.pointerId === session.pointerId ||
    (session.aliasedPointerId !== null && event.pointerId === session.aliasedPointerId)
  )
}

export function attachHeaderDragWindowListeners<TSession extends HeaderDragPointerSession>(args: {
  getSession: () => TSession | null
  onMove: (session: TSession, event: PointerEvent) => void
  onEnd: (commit: boolean, event: PointerEvent) => void
  onCancel: () => void
}): () => void {
  const ignoredPenPointerIds = new Set<number>()

  // Track pen contacts that initiated independently so WSLg adoption only accepts move-only handoffs.
  const onPointerDownCapture = (event: PointerEvent): void => {
    const session = args.getSession()
    if (
      session &&
      session.pointerType === 'mouse' &&
      event.pointerType === 'pen' &&
      event.pointerId !== session.pointerId &&
      event.pointerId !== session.aliasedPointerId
    ) {
      ignoredPenPointerIds.add(event.pointerId)
    }
  }
  const onPointerEndCapture = (event: PointerEvent): void => {
    ignoredPenPointerIds.delete(event.pointerId)
  }
  const onPointerMove = (event: PointerEvent): void => {
    const session = args.getSession()
    if (!session || !matchesHeaderDragPointerMove(session, event, ignoredPenPointerIds)) {
      return
    }
    args.onMove(session, event)
  }
  const onPointerEnd = (event: PointerEvent): void => {
    const session = args.getSession()
    if (session && matchesHeaderDragPointerEnd(session, event)) {
      args.onEnd(event.type === 'pointerup', event)
    }
  }
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      args.onCancel()
    }
  }
  const onBlur = (): void => args.onCancel()

  window.addEventListener('pointerdown', onPointerDownCapture, true)
  window.addEventListener('pointerup', onPointerEndCapture, true)
  window.addEventListener('pointercancel', onPointerEndCapture, true)
  window.addEventListener('pointermove', onPointerMove)
  window.addEventListener('pointerup', onPointerEnd)
  window.addEventListener('pointercancel', onPointerEnd)
  window.addEventListener('keydown', onKeyDown)
  window.addEventListener('blur', onBlur)
  return () => {
    window.removeEventListener('pointerdown', onPointerDownCapture, true)
    window.removeEventListener('pointerup', onPointerEndCapture, true)
    window.removeEventListener('pointercancel', onPointerEndCapture, true)
    window.removeEventListener('pointermove', onPointerMove)
    window.removeEventListener('pointerup', onPointerEnd)
    window.removeEventListener('pointercancel', onPointerEnd)
    window.removeEventListener('keydown', onKeyDown)
    window.removeEventListener('blur', onBlur)
    ignoredPenPointerIds.clear()
  }
}
