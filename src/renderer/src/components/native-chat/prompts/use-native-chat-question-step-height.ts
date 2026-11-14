import { useLayoutEffect, useRef, type RefObject } from 'react'
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion'
import {
  invalidateNativeChatDockFit,
  nativeChatDockFitActive
} from '../pane/dock/native-chat-dock-fit'

const STEP_HEIGHT_MS = 180

/** Ease the card to each step's own height; off under reduced motion or while the dock is short of room. */
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
    void surface.offsetHeight
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
