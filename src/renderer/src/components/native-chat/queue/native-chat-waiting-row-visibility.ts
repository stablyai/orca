import { useEffect, useState } from 'react'

// Rows this far past the view are drawn before they scroll in.
const MARGIN = '200px'

let observer: IntersectionObserver | null = null
const listeners = new Map<Element, (shown: boolean) => void>()

function observe(element: Element, listener: (shown: boolean) => void): () => void {
  observer ??= new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        listeners.get(entry.target)?.(entry.isIntersecting)
      }
    },
    { rootMargin: MARGIN }
  )
  listeners.set(element, listener)
  observer.observe(element)
  return () => {
    listeners.delete(element)
    observer?.unobserve(element)
  }
}

/** Whether a waiting row is near view. The transcript's window does not reach these rows, so each
 *  asks the browser through one shared observer. Unknown counts as shown. */
export function useNativeChatWaitingRowShown(element: Element | null): boolean {
  const [shown, setShown] = useState(true)
  useEffect(() => {
    if (!element || typeof IntersectionObserver !== 'function') {
      return undefined
    }
    return observe(element, setShown)
  }, [element])
  return shown
}

/** The row's height while it is drawn, so it keeps its place once it is not. */
export function useNativeChatWaitingRowHeight(element: HTMLElement | null, drawn: boolean) {
  const [height, setHeight] = useState<number | null>(null)
  useEffect(() => {
    if (!element || !drawn || typeof ResizeObserver !== 'function') {
      return undefined
    }
    const measure = (): void => setHeight(element.getBoundingClientRect().height)
    measure()
    const resize = new ResizeObserver(measure)
    resize.observe(element)
    return () => resize.disconnect()
  }, [element, drawn])
  return height
}
