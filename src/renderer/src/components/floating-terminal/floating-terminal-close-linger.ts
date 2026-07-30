import { useEffect, useState } from 'react'
import { FLOATING_TERMINAL_CLOSE_TRANSITION_MS } from './floating-terminal-open-transition'

// Buffer past the close transition absorbs render scheduling so unmount never
// clips the exit animation.
export const FLOATING_TERMINAL_CLOSE_LINGER_MS = FLOATING_TERMINAL_CLOSE_TRANSITION_MS + 50

/** True through the close transition after `open` flips false so a tabless
 * floating workspace can finish its exit before App unmounts it. */
export function useFloatingTerminalCloseLinger(open: boolean): boolean {
  const [lingering, setLingering] = useState(false)
  const [prevOpen, setPrevOpen] = useState(open)

  // Why: adjust state during render so lingering is already true in the same
  // commit that flips `open` off; a post-commit effect would let that first
  // commit unmount the panel and cut the exit animation.
  if (open !== prevOpen) {
    setPrevOpen(open)
    setLingering(!open)
  }

  useEffect(() => {
    if (open || !lingering) {
      return
    }
    // Why: guarded like the panel's focus scheduling so a stale dev-reload
    // window settles instead of crashing the effect.
    if (typeof window.setTimeout !== 'function') {
      setLingering(false)
      return
    }
    const timer = window.setTimeout(() => {
      setLingering(false)
    }, FLOATING_TERMINAL_CLOSE_LINGER_MS)
    return () => {
      if (typeof window.clearTimeout === 'function') {
        window.clearTimeout(timer)
      }
    }
  }, [open, lingering])

  return lingering
}
