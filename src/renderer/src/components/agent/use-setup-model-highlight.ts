import { useLayoutEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react'

const NAVIGATION_KEYS = new Set(['ArrowUp', 'ArrowDown', 'Home', 'End'])

/**
 * Starts the model list's highlight on `start`, and returns to it when a search is cleared or the
 * pointer leaves after hovering (to the first result while searching, as cmdk does).
 * Why the navigation flag: controlled cmdk reports user moves and its own first-item picks through
 * the same callback; only its own picks are undone.
 */
export function useSetupModelHighlight(
  root: RefObject<HTMLDivElement | null>,
  start: string | undefined,
  query: string,
  /** Models in the catalog; rows that arrive late can push the start out of view. */
  catalogSize: number
) {
  const [reassert, setReassert] = useState(false)
  const [returnTo, setReturnTo] = useState<string>()
  const navigating = useRef(false)
  // Why: a keyboard move after the last hover is the user's choice, so leaving keeps it.
  const hovered = useRef(false)
  const value = query ? undefined : start
  // Why: cmdk applies `value` only when the prop changes, so after its own pick we release it for
  // one render and set it again. A start that arrives or returns is brought into view.
  useLayoutEffect(() => {
    if (reassert) {
      setReassert(false)
    } else if (returnTo !== undefined) {
      setReturnTo(undefined)
    } else if (value !== undefined) {
      root.current
        ?.querySelector(`[cmdk-item][data-value="${CSS.escape(value)}"]`)
        ?.scrollIntoView({ block: 'nearest' })
    }
  }, [reassert, returnTo, value, root, catalogSize])
  return {
    // The flag spans one event: set before cmdk handles it, cleared once it bubbles past the list.
    command: {
      value: reassert ? undefined : (returnTo ?? value),
      onValueChange: (next: string) => {
        if (!navigating.current && value !== undefined && next !== value) {
          setReassert(true)
        }
      },
      onPointerMoveCapture: () => {
        navigating.current = true
        hovered.current = true
      },
      onPointerMove: () => {
        navigating.current = false
      },
      onPointerLeave: () => {
        if (!hovered.current) {
          return
        }
        hovered.current = false
        const target =
          value ??
          root.current
            ?.querySelector('[cmdk-item]:not([data-disabled="true"])')
            ?.getAttribute('data-value') ??
          undefined
        if (target !== undefined) {
          setReturnTo(target)
          setReassert(true)
        }
      }
    },
    onKeyDown: (event: KeyboardEvent) => {
      navigating.current =
        NAVIGATION_KEYS.has(event.key) || (event.ctrlKey && 'jknp'.includes(event.key))
      if (navigating.current) {
        hovered.current = false
      }
    },
    endKey: () => {
      navigating.current = false
    }
  }
}
