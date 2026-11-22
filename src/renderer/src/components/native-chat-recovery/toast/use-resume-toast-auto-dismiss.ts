import { useEffect, useState, type FocusEvent } from 'react'

/** How long an all-resumed report stays on its own. */
const RESUMED_TOAST_MS = 5000

type AutoDismiss = {
  onDetailsOpened: () => void
  interactionHandlers: {
    onPointerEnter: () => void
    onPointerLeave: () => void
    onFocusCapture: () => void
    onBlurCapture: (event: FocusEvent<HTMLElement>) => void
  }
}

/**
 * Sonner owns the timer; holding the duration at infinity protects interaction when an update
 * resets its hover state. Leaving or blurring starts a fresh five seconds, and opening Details
 * keeps the report until the toast is closed.
 */
export function useResumeToastAutoDismiss(
  transient: boolean,
  setDuration: (durationMs: number) => void
): AutoDismiss {
  const [detailsOpened, setDetailsOpened] = useState(false)
  const [focusWithin, setFocusWithin] = useState(false)
  const [pointerWithin, setPointerWithin] = useState(false)
  const autoDismiss = transient && !detailsOpened && !focusWithin && !pointerWithin
  useEffect(() => {
    const timer = window.setTimeout(() => setDuration(autoDismiss ? RESUMED_TOAST_MS : Infinity), 0)
    return () => window.clearTimeout(timer)
  }, [autoDismiss, setDuration])
  return {
    onDetailsOpened: () => setDetailsOpened(true),
    interactionHandlers: {
      onPointerEnter: () => setPointerWithin(true),
      onPointerLeave: () => setPointerWithin(false),
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
