import { useEffect, useRef } from 'react'
import {
  AUTOMATIONS_REVEAL_RUN_EVENT,
  type AutomationsRevealRunDetail
} from './automations-reveal-run'

/**
 * Scrolls a virtualized run table to a run when the page asks, so returning from an
 * off-screen run can focus its row: an unmounted row has no element to focus.
 */
export function useRevealAutomationRun(
  indexOfRun: (runId: string) => number,
  scrollToIndex: (index: number) => void
): void {
  const latestRef = useRef({ indexOfRun, scrollToIndex })
  useEffect(() => {
    latestRef.current = { indexOfRun, scrollToIndex }
  })
  useEffect(() => {
    const onReveal = (event: Event): void => {
      if (!(event instanceof CustomEvent)) {
        return
      }
      const detail: Partial<AutomationsRevealRunDetail> | null = event.detail
      if (typeof detail?.runId !== 'string') {
        return
      }
      const index = latestRef.current.indexOfRun(detail.runId)
      if (index >= 0) {
        latestRef.current.scrollToIndex(index)
      }
    }
    window.addEventListener(AUTOMATIONS_REVEAL_RUN_EVENT, onReveal)
    return () => window.removeEventListener(AUTOMATIONS_REVEAL_RUN_EVENT, onReveal)
  }, [])
}
