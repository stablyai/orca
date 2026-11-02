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

// Hangul has no candidate step, so the Enter that commits it is the user's own Enter.
const HANGUL_ONLY = /^\p{Script=Hangul}+$/u

/** Carry confirmation through the next frame: Windows/Linux redispatch bare Enter before keyup, macOS after. Scope expiry by gesture identity so older frames cannot clear newer carry. */
export function useImeEnterGestureOwnership(): {
  isComposing: () => boolean
  ownsKeyDown: (event: ImeEnterGestureEvent) => boolean
  onKeyUp: (event: ImeEnterGestureEvent) => void
  onCompositionEnd: (committedText?: string) => void
  reset: () => void
  setComposing: (active: boolean, committedText?: string) => void
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
    // Chorded Enter is deliberate submit, not bare IME redispatch; arm carry but do not swallow the chord.
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
          // Spend carry for either outcome; swallow only bare Enter, never the user’s chorded submit.
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
      onCompositionEnd: (committedText = '') => {
        const compositionWasActive = stateRef.current.composing
        stateRef.current.composing = false
        if (HANGUL_ONLY.test(committedText)) {
          stateRef.current.pendingEnter = null
        } else if (compositionWasActive && !stateRef.current.pendingEnter) {
          // IBus can finish composition before its only unmarked confirming Enter.
          stateRef.current.pendingEnter = {}
          expirePendingEnter()
        }
      },
      reset,
      setComposing: (active: boolean, committedText = '') => {
        stateRef.current.composing = active
        if (!active && HANGUL_ONLY.test(committedText)) {
          stateRef.current.pendingEnter = null
        }
      }
    }
  }, [])
}

/** Ignore candidate-confirming Enter in commit inputs; isComposing covers most browsers and keyCode 229 covers IMEs missing that flag. */
export function isImeCompositionKeyDown(event: ReactKeyboardEvent): boolean {
  return isImeOwnedKeyboardEvent(event)
}
