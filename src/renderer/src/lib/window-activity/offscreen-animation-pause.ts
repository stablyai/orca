// Running CSS animations make the compositor tick every refresh even when scrolled out of view or clipped.
export const OFFSCREEN_ANIMATION_ATTRIBUTE = 'data-animation-offscreen'
const RUNNING_ANIMATION_ATTRIBUTE = 'data-animation-running'

type AnimationObservation = {
  intersecting: boolean
  offscreen: number
  visible: number
}

let observer: IntersectionObserver | null = null
const observations = new Map<Element, AnimationObservation>()

function updateVisibleAnimation(element: Element, observation: AnimationObservation): void {
  if (observation.visible > 0) {
    element.toggleAttribute(
      RUNNING_ANIMATION_ATTRIBUTE,
      observation.intersecting && document.visibilityState === 'visible'
    )
  }
}

function updateDocumentVisibility(): void {
  for (const [element, observation] of observations) {
    updateVisibleAnimation(element, observation)
  }
}

function getObserver(): IntersectionObserver | null {
  if (typeof IntersectionObserver !== 'function') {
    return null
  }
  observer ??= new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const observation = observations.get(entry.target)
      if (!observation) {
        continue
      }
      observation.intersecting = entry.isIntersecting
      if (observation.offscreen > 0) {
        entry.target.toggleAttribute(OFFSCREEN_ANIMATION_ATTRIBUTE, !entry.isIntersecting)
      }
      updateVisibleAnimation(entry.target, observation)
    }
  })
  return observer
}

function observeAnimation(element: Element | null, mode: 'offscreen' | 'visible'): () => void {
  if (element === null) {
    return () => {}
  }
  const shared = getObserver()
  const attribute = mode === 'visible' ? RUNNING_ANIMATION_ATTRIBUTE : OFFSCREEN_ANIMATION_ATTRIBUTE
  if (shared === null) {
    if (mode === 'visible') {
      element.setAttribute(attribute, '')
    }
    return () => element.removeAttribute(attribute)
  }

  let observation = observations.get(element)
  if (!observation) {
    if (observations.size === 0) {
      document.addEventListener('visibilitychange', updateDocumentVisibility)
    }
    observation = { intersecting: false, offscreen: 0, visible: 0 }
    observations.set(element, observation)
    shared.observe(element)
  }
  observation[mode]++
  updateVisibleAnimation(element, observation)

  return () => {
    observation[mode]--
    if (observation[mode] === 0) {
      element.removeAttribute(attribute)
    }
    if (observation.offscreen + observation.visible === 0) {
      shared.unobserve(element)
      observations.delete(element)
    }
    if (observations.size === 0) {
      shared.disconnect()
      observer = null
      document.removeEventListener('visibilitychange', updateDocumentVisibility)
    }
  }
}

/** Ref callback: marks offscreen elements so existing subtree animation rules can pause them. */
export function observeOffscreenAnimation(element: Element | null): () => void {
  return observeAnimation(element, 'offscreen')
}

/** Ref callback: starts paused until the element intersects in a visible document. */
export function observeVisibleAnimation(element: Element | null): () => void {
  return observeAnimation(element, 'visible')
}
