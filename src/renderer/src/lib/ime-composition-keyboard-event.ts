import { useMemo, useRef, type KeyboardEvent as ReactKeyboardEvent } from 'react'

type ImeKeyboardEvent = {
  isComposing?: boolean
  keyCode?: number
  nativeEvent?: { isComposing?: boolean; keyCode?: number }
}

type ImeModifierGestureEvent = ImeKeyboardEvent & {
  altKey?: boolean
  ctrlKey?: boolean
  metaKey?: boolean
  shiftKey?: boolean
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

export function resolveImeModifierGesture(
  active: boolean,
  event: ImeModifierGestureEvent
): { active: boolean; carried: boolean; owned: boolean } {
  const hasModifier = Boolean(event.altKey || event.ctrlKey || event.metaKey || event.shiftKey)
  const marked = isImeOwnedKeyboardEvent(event)
  const owned = active || (hasModifier && marked)
  return { active: owned && hasModifier, carried: active && !marked, owned }
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
          (event.nativeEvent.isComposing || stateRef.current.composing) &&
          (isPlainEnter(event) ||
            (event.key === 'Enter' && event.keyCode === 229) ||
            (event.key === 'Process' && event.keyCode === 229))
        if (markedEnter) {
          stateRef.current.pendingEnter = {}
          return true
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
      onKeyUp: (event: ImeEnterGestureEvent): void => {
        // A Process/229 keyup means the IME finished without redispatching, so the
        // gesture is over immediately.
        if (event.key === 'Process' && event.keyCode === 229) {
          stateRef.current.pendingEnter = null
          return
        }
        // Every other keyup expires on the NEXT FRAME, never synchronously. Enter/13
        // because macOS delivers keyup before the unmarked redispatch; anything else
        // because IMEs reporting Process/229 on every key (Pinyin candidate selection)
        // release a non-Enter key, and a Process-only clear left the carry armed and ate
        // the user's next real Enter.
        const pendingEnter = stateRef.current.pendingEnter
        if (pendingEnter) {
          requestAnimationFrame(() => {
            if (stateRef.current.pendingEnter === pendingEnter) {
              stateRef.current.pendingEnter = null
            }
          })
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
