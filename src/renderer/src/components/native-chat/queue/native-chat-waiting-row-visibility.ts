import { useEffect, useState } from 'react'

// Rows this far past the view are drawn before they scroll in.
const MARGIN = '200px'

// One observer per scroller (transcript or setup mail block): the margin applies to the one clipping the rows.
const observers = new Map<Element | null, { observer: IntersectionObserver; rows: number }>()
const listeners = new Map<Element, (shown: boolean) => void>()

function observe(element: Element, listener: (shown: boolean) => void): () => void {
  const root = element.closest('[data-native-chat-scroll],[data-native-chat-waiting-mail-scroll]')
  let shared = observers.get(root)
  if (!shared) {
    shared = {
      observer: new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            listeners.get(entry.target)?.(entry.isIntersecting)
          }
        },
        { root, rootMargin: MARGIN }
      ),
      rows: 0
    }
    observers.set(root, shared)
  }
  const own = shared
  own.rows++
  listeners.set(element, listener)
  own.observer.observe(element)
  return () => {
    listeners.delete(element)
    own.observer.unobserve(element)
    own.rows--
    if (own.rows === 0) {
      own.observer.disconnect()
      observers.delete(root)
    }
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
