import { useEffect, useState, type FocusEvent } from 'react'

/** How long an all-resumed report stays on its own. */
const RESUMED_TOAST_MS = 5000

type AutoDismiss = {
  onDetailsOpened: () => void
  focusHandlers: {
    onFocusCapture: () => void
    onBlurCapture: (event: FocusEvent<HTMLElement>) => void
  }
}

/**
 * A clean report leaves on its own through the toaster's timer, which already pauses under the
 * pointer. The toaster does not pause for keyboard focus, so focus inside holds it; opening Details
 * keeps it until closed so the list never vanishes while it is being read.
 */
export function useResumeToastAutoDismiss(
  transient: boolean,
  setDuration: (durationMs: number) => void
): AutoDismiss {
  const [detailsOpened, setDetailsOpened] = useState(false)
  const [focusWithin, setFocusWithin] = useState(false)
  const autoDismiss = transient && !detailsOpened && !focusWithin
  useEffect(() => {
    const timer = window.setTimeout(() => setDuration(autoDismiss ? RESUMED_TOAST_MS : Infinity), 0)
    return () => window.clearTimeout(timer)
  }, [autoDismiss, setDuration])
  return {
    onDetailsOpened: () => setDetailsOpened(true),
    focusHandlers: {
      onFocusCapture: () => setFocusWithin(true),
      onBlurCapture: (event) => {
        const next = event.relatedTarget
        if (!(next instanceof Node) || !event.currentTarget.contains(next)) {
          setFocusWithin(false)
        }
      }
    }
  }
}
