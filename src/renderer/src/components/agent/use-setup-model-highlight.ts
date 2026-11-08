import { useLayoutEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react'

const NAVIGATION_KEYS = new Set(['ArrowUp', 'ArrowDown', 'Home', 'End'])

/**
 * Starts the model list's highlight on `start`, and returns to it when a search is cleared.
 * Why the navigation flag: controlled cmdk reports user moves and its own first-item picks through
 * the same callback; only its own picks are undone.
 */
export function useSetupModelHighlight(
  root: RefObject<HTMLDivElement | null>,
  start: string | undefined,
  query: string
) {
  const [reassert, setReassert] = useState(false)
  const navigating = useRef(false)
  const value = query ? undefined : start
  // Why: cmdk applies `value` only when the prop changes, so after its own pick we release it for
  // one render and set it again. A start that arrives or returns is brought into view.
  useLayoutEffect(() => {
    if (reassert) {
      setReassert(false)
    } else if (value !== undefined) {
      root.current
        ?.querySelector(`[cmdk-item][data-value="${CSS.escape(value)}"]`)
        ?.scrollIntoView({ block: 'nearest' })
    }
  }, [reassert, value, root])
  return {
    // The flag spans one event: set before cmdk handles it, cleared once it bubbles past the list.
    command: {
      value: reassert ? undefined : value,
      onValueChange: (next: string) => {
        if (!navigating.current && value !== undefined && next !== value) {
          setReassert(true)
        }
      },
      onPointerMoveCapture: () => {
        navigating.current = true
      },
      onPointerMove: () => {
        navigating.current = false
      }
    },
    onKeyDown: (event: KeyboardEvent) => {
      navigating.current =
        NAVIGATION_KEYS.has(event.key) || (event.ctrlKey && 'jknp'.includes(event.key))
    },
    endKey: () => {
      navigating.current = false
    }
  }
}
