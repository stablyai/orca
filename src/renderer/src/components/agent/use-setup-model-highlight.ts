import { useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'

const NAVIGATION_KEYS = new Set(['ArrowUp', 'ArrowDown', 'Home', 'End'])

/**
 * Starts the model list's highlight on `start`, and returns to it when a search is cleared.
 * Why the navigation flag: controlled cmdk reports user moves and its own first-item picks through
 * the same callback; only its own picks are undone.
 */
export function useSetupModelHighlight(start: string | undefined, query: string) {
  const [reassert, setReassert] = useState(false)
  const navigating = useRef(false)
  const value = query ? undefined : start
  // Why: cmdk applies `value` only when the prop changes, so after its own pick we release it for
  // one render and set it again.
  useLayoutEffect(() => {
    if (reassert) {
      setReassert(false)
    }
  }, [reassert])
  return {
    value: reassert ? undefined : value,
    onValueChange: (next: string) => {
      if (navigating.current) {
        navigating.current = false
      } else if (value !== undefined && next !== value) {
        setReassert(true)
      }
    },
    onKeyDown: (event: KeyboardEvent) => {
      navigating.current =
        NAVIGATION_KEYS.has(event.key) || (event.ctrlKey && 'jknp'.includes(event.key))
    },
    onPointerMoveCapture: () => {
      navigating.current = true
    }
  }
}
