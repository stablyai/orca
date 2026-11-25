import { useEffect, useState, type RefCallback } from 'react'

/** Observe the actual viewport; retained bodies pause work without losing selection or focus.
 * 'viewport' observes against the window, still clipped by overflow ancestors. */
export function useSectionOnScreen(
  root: Element | null | 'viewport'
): [RefCallback<Element>, boolean] {
  const [element, setElement] = useState<Element | null>(null)
  const [onScreen, setOnScreen] = useState(false)
  useEffect(() => {
    if (!element || !root) {
      return
    }
    if (typeof IntersectionObserver !== 'function') {
      setOnScreen(true)
      return
    }
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries.at(-1)
        if (entry) {
          setOnScreen(entry.isIntersecting)
        }
      },
      { root: root === 'viewport' ? null : root }
    )
    observer.observe(element)
    return () => observer.disconnect()
  }, [element, root])
  return [setElement, onScreen]
}
