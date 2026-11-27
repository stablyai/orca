import { useMemo, useRef, type KeyboardEvent as ReactKeyboardEvent } from 'react'

type ImeKeyboardEvent = {
  isComposing?: boolean
  keyCode?: number
  nativeEvent?: { isComposing?: boolean; keyCode?: number }
}

/** True when the IME, rather than Orca, owns a keyboard event. Generic so synthetic, native, and
 * gesture events each pass their own richer shape. */
export function isImeOwnedKeyboardEvent<KeyEvent extends ImeKeyboardEvent>(
  event: KeyEvent
): boolean {
  return (
    event.isComposing === true ||
    event.keyCode === 229 ||
    event.nativeEvent?.isComposing === true ||
    event.nativeEvent?.keyCode === 229
  )
}

/** True when `code` is the physical Enter key or unknown, as IMEs report for processed keys. */
export function isEnterOrUnknownCode(code: string | undefined): boolean {
  return !code || code === 'Unidentified' || code === 'Enter' || code === 'NumpadEnter'
}

type ImeEnterGestureEvent = Pick<ReactKeyboardEvent, 'key' | 'keyCode' | 'nativeEvent'> & {
  code?: string
}

/** Enter belongs to the IME only while it composes. The bare Enter that can follow compositionend
 * from the same keypress (Hangul, Vietnamese) is the user's own Enter; candidate IMEs send none. */
export function useImeEnterGestureOwnership(): {
  isComposing: () => boolean
  ownsKeyDown: (event: ImeEnterGestureEvent) => boolean
  reset: () => void
  setComposing: (active: boolean) => void
} {
  const composingRef = useRef(false)

  return useMemo(
    () => ({
      isComposing: () => composingRef.current,
      ownsKeyDown: (event: ImeEnterGestureEvent): boolean =>
        (event.key === 'Enter' || (event.key === 'Process' && isEnterOrUnknownCode(event.code))) &&
        (composingRef.current || isImeOwnedKeyboardEvent(event)),
      reset: () => {
        composingRef.current = false
      },
      setComposing: (active: boolean) => {
        composingRef.current = active
      }
    }),
    []
  )
}

/** Ignore candidate-confirming Enter in commit inputs; isComposing covers most browsers and keyCode 229 covers IMEs missing that flag. */
export function isImeCompositionKeyDown(event: ReactKeyboardEvent): boolean {
  return isImeOwnedKeyboardEvent(event)
}
