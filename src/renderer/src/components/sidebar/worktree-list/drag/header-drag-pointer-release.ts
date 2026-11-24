/** Detect a lost pointerup, including release before the window-listener effect or interception in capture phase. */
export function hasPointerBeenReleased(event: PointerEvent): boolean {
  return event.buttons === 0
}
