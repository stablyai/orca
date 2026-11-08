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
  const restoring = useRef(false)
  const value = query ? undefined : start
  // Why: cmdk applies `value` only when the prop changes, so after its own pick we release it for
  // one render and set it again, then bring that row into view as cmdk would.
  useLayoutEffect(() => {
    if (reassert) {
      restoring.current = true
      setReassert(false)
    } else if (restoring.current && value !== undefined) {
      restoring.current = false
      root.current
        ?.querySelector(`[cmdk-item][data-value="${CSS.escape(value)}"]`)
        ?.scrollIntoView({ block: 'nearest' })
    }
  }, [reassert, value, root])
  // cmdk handles a navigation key or pointer move synchronously, so the flag lasts only for that event.
  const markNavigating = (on: boolean) => {
    navigating.current = on
    if (on) {
      queueMicrotask(() => {
        navigating.current = false
      })
    }
  }
  return {
    command: {
      value: reassert ? undefined : value,
      onValueChange: (next: string) => {
        if (!navigating.current && value !== undefined && next !== value) {
          setReassert(true)
        }
      },
      onPointerMoveCapture: () => markNavigating(true)
    },
    onKeyDown: (event: KeyboardEvent) =>
      markNavigating(
        NAVIGATION_KEYS.has(event.key) || (event.ctrlKey && 'jknp'.includes(event.key))
      )
  }
}
