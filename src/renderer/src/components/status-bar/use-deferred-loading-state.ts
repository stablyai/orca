import { useEffect, useState } from 'react'

// Why: a host that answers quickly must not flash a placeholder.
// See docs/STYLEGUIDE.md — "Don't pick worst-case feedback for everyone".
export const LOADING_AFFORDANCE_DELAY_MS = 200

export function useDeferredLoadingState(
  pending: boolean,
  delayMs: number = LOADING_AFFORDANCE_DELAY_MS
): boolean {
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    if (!pending) {
      setVisible(false)
      return
    }
    const timer = window.setTimeout(() => setVisible(true), delayMs)
    return () => {
      window.clearTimeout(timer)
    }
  }, [pending, delayMs])

  return pending && visible
}
