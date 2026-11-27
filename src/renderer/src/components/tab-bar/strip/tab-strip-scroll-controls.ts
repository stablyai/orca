import { motionSafeScrollBehavior } from '@/hooks/theme/usePrefersReducedMotion'

const TAB_STRIP_SCROLL_FRACTION = 0.75
const TAB_STRIP_MIN_SCROLL_STEP_PX = 120

export function scrollTabStripByStep(
  el: HTMLElement,
  direction: 'start' | 'end',
  behavior: ScrollBehavior = 'smooth'
): void {
  el.scrollBy({
    left:
      direction === 'start'
        ? -Math.max(TAB_STRIP_MIN_SCROLL_STEP_PX, el.clientWidth * TAB_STRIP_SCROLL_FRACTION)
        : Math.max(TAB_STRIP_MIN_SCROLL_STEP_PX, el.clientWidth * TAB_STRIP_SCROLL_FRACTION),
    behavior: motionSafeScrollBehavior(behavior)
  })
}

export function isTabStripScrolledToEnd(el: HTMLElement): boolean {
  return el.scrollLeft >= Math.max(0, el.scrollWidth - el.clientWidth) - 2
}
