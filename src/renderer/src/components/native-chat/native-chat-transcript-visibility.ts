type VisibilityListener = (isVisible: boolean) => void

const visibilityListeners = new Map<Element, VisibilityListener>()
let visibilityObserver: IntersectionObserver | null = null

export function observeTranscriptVisibility(
  element: Element,
  listener: VisibilityListener
): () => void {
  if (typeof IntersectionObserver === 'undefined') {
    listener(true)
    return () => {}
  }

  visibilityObserver ??= new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        visibilityListeners.get(entry.target)?.(entry.isIntersecting)
      }
    },
    { rootMargin: '128px' }
  )
  visibilityListeners.set(element, listener)
  visibilityObserver.observe(element)

  return () => {
    visibilityListeners.delete(element)
    visibilityObserver?.unobserve(element)
    if (visibilityListeners.size === 0) {
      visibilityObserver?.disconnect()
      visibilityObserver = null
    }
  }
}
