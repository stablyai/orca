/**
 * True when a pointermove arrives with no button held, meaning the pointerup
 * that should have ended the armed drag never reached us.
 *
 * Why: the header drag hooks subscribe to window pointer events from an effect
 * armed by pointerdown state, so a fast click's release can land before that
 * effect runs (a heavy sidebar render sits between them). The session then
 * survives the click and the next hover promotes a drag the user is not doing —
 * for host sections that hides the header outright and force-collapses every
 * host. A capture-phase listener swallowing pointerup has the same effect.
 */
export function hasPointerBeenReleased(event: PointerEvent): boolean {
  return event.buttons === 0
}
