import { hasVisibleOverlay } from '@/lib/overlay-interaction/visible-overlay'
import { hasContextualTourActionStep } from '../../../../shared/contextual-tour-action-steps'
import { useEffect, useRef, type RefObject } from 'react'
import { getContextualTour, type ContextualTourId } from '../../../../shared/contextual-tours'
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
    const firstStepOfActivation = focusedStepRef.current === null
    focusedStepRef.current = focusKey
    // Passive announcements and action tours must not redirect ongoing typing.
    const focusWasInCallout =
      document.activeElement === document.body ||
      !!panelRef.current?.contains(document.activeElement)
    const tour = getContextualTour(activeTourId)
    if (
      tour.preserveFocus ||
      (hasContextualTourActionStep(tour) && (firstStepOfActivation || !focusWasInCallout))
    ) {
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
      if (!panel || hasVisibleOverlay({ ignoreContaining: panel })) {
        return
      }
      const firstFocusable = getContextualTourFocusableElements(panel)[0]
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
    if (
      previousFocus?.isConnected &&
      !hasVisibleOverlay({ ignoreContaining: previousFocus, ignoreDismissed: true })
    ) {
      previousFocus.focus({ preventScroll: true })
    }
  }, [activeTourId])
}
