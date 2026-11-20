// Running CSS animations make the compositor tick every refresh even when scrolled out of view or clipped.
export const OFFSCREEN_ANIMATION_ATTRIBUTE = 'data-animation-offscreen'
// Virtual-list rows (overscan included) pause only their endless loops, so a finite exit animation still ends.
export const OFFSCREEN_ROW_ATTRIBUTE = 'data-row-offscreen'

let observer: IntersectionObserver | null = null
let observedCount = 0
const rowTargets = new WeakSet<Element>()

function getObserver(): IntersectionObserver | null {
  if (typeof IntersectionObserver !== 'function') {
    return null
  }
  observer ??= new IntersectionObserver((entries) => {
    for (const entry of entries) {
      entry.target.toggleAttribute(
        rowTargets.has(entry.target) ? OFFSCREEN_ROW_ATTRIBUTE : OFFSCREEN_ANIMATION_ATTRIBUTE,
        !entry.isIntersecting
      )
    }
  })
  return observer
}

function observe(element: Element | null, attribute: string): () => void {
  const shared = getObserver()
  if (element === null || shared === null) {
    return () => {}
  }
  if (attribute === OFFSCREEN_ROW_ATTRIBUTE) {
    rowTargets.add(element)
  }
  shared.observe(element)
  observedCount++
  return () => {
    shared.unobserve(element)
    rowTargets.delete(element)
    element.removeAttribute(attribute)
    observedCount--
    if (observedCount === 0) {
      shared.disconnect()
      observer = null
    }
  }
}

/** Ref callback: marks the element while it is outside the viewport so CSS can stop its animation. */
export function observeOffscreenAnimation(element: Element | null): () => void {
  return observe(element, OFFSCREEN_ANIMATION_ATTRIBUTE)
}

/** Marks a virtual-list row while it is outside the viewport so CSS can pause its endless loops. */
export function observeOffscreenRow(element: Element): () => void {
  return observe(element, OFFSCREEN_ROW_ATTRIBUTE)
}
