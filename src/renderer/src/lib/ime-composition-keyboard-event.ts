import type { KeyboardEvent as ReactKeyboardEvent } from 'react'

/**
 * Why: CJK IMEs (Japanese/Chinese/Korean) fire a keydown for the Enter that
 * only confirms a conversion candidate. Rename/title inputs that commit on
 * `Enter` must ignore that keydown, otherwise they submit mid-composition with a
 * half-converted value. `isComposing` covers most browsers; `keyCode === 229` is
 * a defensive fallback for IMEs that don't set `isComposing` on keydown.
 */
export function isImeCompositionKeyDown(event: ReactKeyboardEvent): boolean {
  const nativeEvent = event.nativeEvent
  return nativeEvent.isComposing || nativeEvent.keyCode === 229
}
