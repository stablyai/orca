// Running CSS animations make the compositor tick every refresh even when scrolled out of view or clipped.
export const OFFSCREEN_ANIMATION_ATTRIBUTE = 'data-animation-offscreen'
// Virtual-list rows (overscan included) pause only their endless loops, so a finite exit animation still ends.
export const OFFSCREEN_ROW_ATTRIBUTE = 'data-row-offscreen'

let observer: IntersectionObserver | null = null
let observedCount = 0
// Entries can arrive after unobserve; only registered targets are marked.
const attributeByTarget = new Map<Element, string>()

function getObserver(): IntersectionObserver | null {
  if (typeof IntersectionObserver !== 'function') {
    return null
  }
  observer ??= new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const attribute = attributeByTarget.get(entry.target)
      if (attribute !== undefined) {
        entry.target.toggleAttribute(attribute, !entry.isIntersecting)
      }
    }
  })
  return observer
}

function observe(element: Element | null, attribute: string): () => void {
  const shared = getObserver()
  if (element === null || shared === null) {
    return () => {}
  }
  attributeByTarget.set(element, attribute)
  shared.observe(element)
  observedCount++
  return () => {
    shared.unobserve(element)
    attributeByTarget.delete(element)
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

const rowRegistrations = new Map<Element, { count: number; stop: () => void }>()

/** Marks a virtual-list row while it is outside the viewport so CSS can pause its endless loops. */
export function observeOffscreenRow(element: Element): () => void {
  const registration = rowRegistrations.get(element)
  if (registration) {
    registration.count++
  } else {
    rowRegistrations.set(element, { count: 1, stop: observe(element, OFFSCREEN_ROW_ATTRIBUTE) })
  }
  return () => {
    const current = rowRegistrations.get(element)
    if (!current || --current.count > 0) {
      return
    }
    // A ref re-attached in the same commit (list re-derived) keeps its observation and marker.
    queueMicrotask(() => {
      if (rowRegistrations.get(element) === current && current.count === 0) {
        rowRegistrations.delete(element)
        current.stop()
      }
    })
  }
}
