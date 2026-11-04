import { useEffect, useRef, type RefObject } from 'react'
import {
  getContextualTour,
  hasContextualTourActionStep,
  type ContextualTourId
} from '../../../../shared/contextual-tours'
import { getContextualTourFocusableElements } from './ContextualTourOverlaySurface'

// Moves focus into a newly shown tour step and gives it back when the tour ends.
export function useContextualTourFocus({
  activeTourId,
  activeStepIndex,
  rendered,
  panelRef
}: {
  activeTourId: ContextualTourId | null
  activeStepIndex: number
  rendered: boolean
  panelRef: RefObject<HTMLElement | null>
}): void {
  const previousFocusRef = useRef<HTMLElement | null>(null)
  const focusedStepRef = useRef<string | null>(null)

  useEffect(() => {
    if (!activeTourId || !rendered) {
      return
    }
    const focusKey = `${activeTourId}:${activeStepIndex}`
    if (focusedStepRef.current === focusKey) {
      return
    }
    focusedStepRef.current = focusKey
    // A tour that waits for the user to act (split a pane) shows while they type in the terminal and
    // keeps coming back until they do; taking focus would send those keystrokes to its dismiss button.
    if (hasContextualTourActionStep(getContextualTour(activeTourId))) {
      return
    }

    const currentFocus = document.activeElement
    if (
      !previousFocusRef.current &&
      currentFocus instanceof HTMLElement &&
      !panelRef.current?.contains(currentFocus)
    ) {
      previousFocusRef.current = currentFocus
    }

    const timeout = window.setTimeout(() => {
      const panel = panelRef.current
      const firstFocusable = panel ? getContextualTourFocusableElements(panel)[0] : null
      ;(firstFocusable ?? panel)?.focus({ preventScroll: true })
    }, 0)
    return () => window.clearTimeout(timeout)
  }, [activeStepIndex, activeTourId, panelRef, rendered])

  useEffect(() => {
    if (activeTourId) {
      return
    }
    focusedStepRef.current = null
    const previousFocus = previousFocusRef.current
    previousFocusRef.current = null
    if (previousFocus?.isConnected) {
      previousFocus.focus({ preventScroll: true })
    }
  }, [activeTourId])
}
