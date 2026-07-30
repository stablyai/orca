import { useLayoutEffect, useState } from 'react'
import type { RefObject } from 'react'

// Open decelerates in over 200ms (duration-200 on the panel root); close
// accelerates out — asymmetric timing keeps the constantly-hit toggle snappy.
export const FLOATING_TERMINAL_CLOSE_TRANSITION_MS = 150

export type FloatingTerminalOpenTransition = {
  /** Drives the visual open classes; committed one styled pass after `open` so
   * fresh mounts transition in instead of rendering the final state. */
  visualOpen: boolean
  /** True once the close transition settles; gates `visibility: hidden`. */
  hidden: boolean
}

export function useFloatingTerminalOpenTransition(
  open: boolean,
  panelRef: RefObject<HTMLElement | null>
): FloatingTerminalOpenTransition {
  const [visualOpen, setVisualOpen] = useState(false)
  const [exitDone, setExitDone] = useState(!open)

  useLayoutEffect(() => {
    if (open) {
      setExitDone(false)
      // Why: reading offsetWidth flushes the committed closed-visuals styles so
      // the pre-paint flip to open visuals transitions instead of snapping,
      // including when the panel mounts directly into `open`.
      void panelRef.current?.offsetWidth
      setVisualOpen(true)
      return
    }
    setVisualOpen(false)
    // Why: a timer instead of transitionend so reduced-motion (transition: none)
    // still settles into the hidden state; guarded like the panel's focus
    // scheduling so a stale dev-reload window cannot crash the effect.
    if (typeof window.setTimeout !== 'function') {
      setExitDone(true)
      return
    }
    const timer = window.setTimeout(() => {
      setExitDone(true)
    }, FLOATING_TERMINAL_CLOSE_TRANSITION_MS + 50)
    return () => {
      if (typeof window.clearTimeout === 'function') {
        window.clearTimeout(timer)
      }
    }
  }, [open, panelRef])

  return { visualOpen, hidden: !open && exitDone }
}
