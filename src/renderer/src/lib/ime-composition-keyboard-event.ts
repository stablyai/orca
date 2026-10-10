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

type ImeEnterGestureEvent = Pick<
  ReactKeyboardEvent,
  'key' | 'keyCode' | 'nativeEvent' | 'preventDefault' | 'shiftKey'
> & { altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean }

/**
 * Why: the confirming Enter of a CJK composition arrives as two keydowns, and the
 * two orderings differ by platform. Windows/Linux redispatch the unmarked
 * `Enter`/13 *before* keyup; macOS delivers keyup first and redispatches after.
 * A token that expires synchronously on keyup therefore regresses macOS, so the
 * carry survives until the next animation frame. Identity-scoped so an older
 * gesture's expiry cannot clear a newer one.
 */
export function useImeEnterGestureOwnership(): {
  isComposing: () => boolean
  ownsKeyDown: (event: ImeEnterGestureEvent) => boolean
  onKeyUp: (event: ImeEnterGestureEvent) => void
  onCompositionEnd: () => void
  reset: () => void
  setComposing: (active: boolean) => void
} {
  const stateRef = useRef<{ composing: boolean; pendingEnter: object | null }>({
    composing: false,
    pendingEnter: null
  })

  return useMemo(() => {
    const reset = (): void => {
      stateRef.current = { composing: false, pendingEnter: null }
    }
    const expirePendingEnter = (): void => {
      const pendingEnter = stateRef.current.pendingEnter
      if (pendingEnter) {
        requestAnimationFrame(() => {
          if (stateRef.current.pendingEnter === pendingEnter) {
            stateRef.current.pendingEnter = null
          }
        })
      }
    }
    // Shift+Enter is a newline, never a submit — it must never be owned or swallowed.
    const isPlainEnter = (event: ImeEnterGestureEvent): boolean =>
      event.key === 'Enter' && event.keyCode === 13 && !event.shiftKey
    // The redispatched Enter of a confirm carries no modifiers, so a chorded one is the
    // user's own submit aimed past the IME. It must still ARM, and must never be swallowed.
    const hasChordModifier = (event: ImeEnterGestureEvent): boolean =>
      Boolean(event.altKey || event.ctrlKey || event.metaKey)
    return {
      isComposing: () => stateRef.current.composing,
      ownsKeyDown: (event: ImeEnterGestureEvent): boolean => {
        const markedEnter =
          (isImeOwnedKeyboardEvent(event) || stateRef.current.composing) &&
          (isPlainEnter(event) ||
            (event.key === 'Enter' && event.keyCode === 229) ||
            (event.key === 'Process' && event.keyCode === 229))
        if (markedEnter) {
          stateRef.current.pendingEnter = {}
          return true
        }
        // Continued typing ends the confirmation even when hidden renderers delay the frame.
        if (
          !stateRef.current.composing &&
          !isImeOwnedKeyboardEvent(event) &&
          !['Enter', 'Shift', 'Control', 'Alt', 'Meta'].includes(event.key)
        ) {
          stateRef.current.pendingEnter = null
        }
        if (
          stateRef.current.pendingEnter &&
          isPlainEnter(event) &&
          !event.nativeEvent.isComposing
        ) {
          // The gesture resolves either way, so the carry is spent either way; only a bare
          // Enter is also swallowed, because a chorded one is the user's own submit.
          stateRef.current.pendingEnter = null
          if (hasChordModifier(event)) {
            return false
          }
          event.preventDefault()
          return true
        }
        return false
      },
      onKeyUp: (): void => {
        // Any keyup can precede the redispatch, including an IME-owned Process/229 release.
        expirePendingEnter()
      },
      onCompositionEnd: () => {
        const compositionWasActive = stateRef.current.composing
        stateRef.current.composing = false
        if (compositionWasActive && !stateRef.current.pendingEnter) {
          // IBus can finish composition before its only unmarked confirming Enter.
          stateRef.current.pendingEnter = {}
          expirePendingEnter()
        }
      },
      reset,
      setComposing: (active: boolean) => {
        stateRef.current.composing = active
      }
    }
  }, [])
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
