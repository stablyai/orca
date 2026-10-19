import { useCallback, useRef, useState } from 'react'

/** Whether a one-line `truncate` element cuts its text off, kept current as its width changes.
 *  Attach the returned ref only while the element sits on its line; an opened disclosure keeps
 *  the last verdict, so its toggle stays put. */
export function useNativeChatClippedLine(
  initiallyClipped: boolean
): [clipped: boolean, measureLine: (line: HTMLElement | null) => void] {
  const [clipped, setClipped] = useState(initiallyClipped)
  const observerRef = useRef<ResizeObserver | null>(null)
  const measureLine = useCallback((line: HTMLElement | null) => {
    observerRef.current?.disconnect()
    observerRef.current = null
    if (!line) {
      return
    }
    const measure = (): void => setClipped(line.scrollWidth > line.clientWidth)
    measure()
    if (typeof ResizeObserver === 'undefined') {
      return
    }
    observerRef.current = new ResizeObserver(measure)
    observerRef.current.observe(line)
  }, [])
  return [clipped, measureLine]
}
