import type { KeyboardEvent as ReactKeyboardEvent } from 'react'

type ImeKeyboardEvent = {
  isComposing?: boolean
  keyCode?: number
  nativeEvent?: { isComposing?: boolean; keyCode?: number }
}

/** True when the IME, rather than Orca, owns a keyboard event. */
export function isImeOwnedKeyboardEvent(event: object): boolean {
  const candidate = event as ImeKeyboardEvent
  return (
    candidate.isComposing === true ||
    candidate.keyCode === 229 ||
    candidate.nativeEvent?.isComposing === true ||
    candidate.nativeEvent?.keyCode === 229
  )
}

/**
 * Why: CJK IMEs (Japanese/Chinese/Korean) fire a keydown for the Enter that
 * only confirms a conversion candidate. Rename/title inputs that commit on
 * `Enter` must ignore that keydown, otherwise they submit mid-composition with a
 * half-converted value. `isComposing` covers most browsers; `keyCode === 229` is
 * a defensive fallback for IMEs that don't set `isComposing` on keydown.
 */
export function isImeCompositionKeyDown(event: ReactKeyboardEvent): boolean {
  return isImeOwnedKeyboardEvent(event)
}
