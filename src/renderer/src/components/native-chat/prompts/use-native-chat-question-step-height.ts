import { useLayoutEffect, useRef, type RefObject } from 'react'
import { usePrefersReducedMotion } from '@/hooks/theme/usePrefersReducedMotion'
import { forceLayoutReflow } from '@/lib/overlay-interaction/force-layout-reflow'
import {
  invalidateNativeChatDockFit,
  nativeChatDockFitActive
} from '../pane/dock/native-chat-dock-fit'

const STEP_HEIGHT_MS = 180
const STEP_SCROLLERS =
  '.native-chat-question-card-body, .native-chat-question-card-question, .native-chat-question-card-options'

/** Ease the card to each step's own height (off under reduced motion or while the dock is short
 *  of room), and start each step scrolled to its top. */
export function useNativeChatQuestionStepHeight(
  surfaceRef: RefObject<HTMLElement | null>,
  step: number
): void {
  const reducedMotion = usePrefersReducedMotion()
  const heightRef = useRef<number | null>(null)
  const stepRef = useRef(step)
  // Track the settled height without a layout read per render.
  useLayoutEffect(() => {
    const surface = surfaceRef.current
    if (!surface || typeof ResizeObserver === 'undefined') {
      return
    }
    const observer = new ResizeObserver(([entry]) => {
      if (entry && !surface.hasAttribute('data-native-chat-dock-animating')) {
        heightRef.current = entry.borderBoxSize[0]?.blockSize ?? entry.contentRect.height
      }
    })
    observer.observe(surface)
    return () => observer.disconnect()
  }, [surfaceRef])
  useLayoutEffect(() => {
    const surface = surfaceRef.current
    const from = heightRef.current
    const changed = stepRef.current !== step
    stepRef.current = step
    // The step's scrollers are reused, so a new step starts each of them back at the top.
    if (changed) {
      for (const scroller of surface?.querySelectorAll<HTMLElement>(STEP_SCROLLERS) ?? []) {
        scroller.scrollTop = 0
      }
    }
    if (
      !surface ||
      !changed ||
      from === null ||
      reducedMotion ||
      nativeChatDockFitActive(surface)
    ) {
      return
    }
    const to = surface.getBoundingClientRect().height
    if (Math.abs(to - from) < 2) {
      return
    }
    // The fit pass waits while the card animates, then runs once on the settled height.
    surface.setAttribute('data-native-chat-dock-animating', '')
    surface.style.transition = 'none'
    surface.style.height = `${from}px`
    forceLayoutReflow(surface)
    surface.style.transition = `height ${STEP_HEIGHT_MS}ms ease-out`
    surface.style.height = `${to}px`
    let settled = false
    const settle = (event?: Event): void => {
      if (settled || (event && event.target !== surface)) {
        return
      }
      settled = true
      clearTimeout(timer)
      surface.removeEventListener('transitionend', settle)
      // A step opened mid-transition starts from where this one stopped; the observer skipped it.
      heightRef.current = surface.getBoundingClientRect().height
      surface.style.height = ''
      surface.style.transition = ''
      surface.removeAttribute('data-native-chat-dock-animating')
      invalidateNativeChatDockFit(surface)
    }
    const timer = setTimeout(() => settle(), STEP_HEIGHT_MS + 80)
    surface.addEventListener('transitionend', settle)
    return () => settle()
  }, [surfaceRef, step, reducedMotion])
}
