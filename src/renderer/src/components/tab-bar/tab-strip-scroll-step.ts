const TAB_STRIP_SCROLL_FRACTION = 0.75
const TAB_STRIP_MIN_SCROLL_STEP_PX = 120

export function scrollTabStripByStep(
  el: HTMLElement,
  direction: 'start' | 'end',
  behavior: ScrollBehavior = 'smooth'
): void {
  const scrollStep = Math.max(
    TAB_STRIP_MIN_SCROLL_STEP_PX,
    el.clientWidth * TAB_STRIP_SCROLL_FRACTION
  )
  el.scrollBy({
    left: direction === 'start' ? -scrollStep : scrollStep,
    behavior
  })
}

export function isTabStripScrolledToEnd(el: HTMLElement): boolean {
  const max = Math.max(0, el.scrollWidth - el.clientWidth)
  return el.scrollLeft >= max - 2
}
