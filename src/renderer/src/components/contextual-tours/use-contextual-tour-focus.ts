import { useEffect, useRef, type RefObject } from 'react'
import { useAppStore } from '@/store'
import { getContextualTourFocusableElements } from './ContextualTourOverlaySurface'

// Moves focus into a newly shown tour step and gives it back when the tour ends.
export function useContextualTourFocus({
  activeTourId,
  activeStepIndex,
  rendered,
  panelRef
}: {
  activeTourId: string | null
  activeStepIndex: number
  rendered: boolean
  panelRef: RefObject<HTMLElement | null>
}): void {
  const previousFocusRef = useRef<HTMLElement | null>(null)
  const focusedStepRef = useRef<string | null>(null)
  const pausedTourIdRef = useRef<string | null>(null)

  useEffect(() => {
    if (!activeTourId || !rendered) {
      return
    }
    const focusKey = `${activeTourId}:${activeStepIndex}`
    if (focusedStepRef.current === focusKey) {
      return
    }
    focusedStepRef.current = focusKey
    const resumedAfterPause = pausedTourIdRef.current === activeTourId
    pausedTourIdRef.current = null
    if (resumedAfterPause) {
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
    // A paused tour that comes back, at any step, must not take focus again: a keystroke meant for
    // the terminal would land on its dismiss button. A tour that ended for good is not paused.
    // An activation cancelled before it painted keeps the earlier pause.
    const focusedTourId = focusedStepRef.current?.split(':')[0] ?? pausedTourIdRef.current
    pausedTourIdRef.current =
      focusedTourId && !useAppStore.getState().contextualToursSeenIds.includes(focusedTourId)
        ? focusedTourId
        : null
    focusedStepRef.current = null
    const previousFocus = previousFocusRef.current
    previousFocusRef.current = null
    if (previousFocus?.isConnected) {
      previousFocus.focus({ preventScroll: true })
    }
  }, [activeTourId])
}
