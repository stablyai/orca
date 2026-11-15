import { useCallback, useRef, useState } from 'react'

/** Measure only the collapsed line; preserve its last clipping verdict while expanded so the toggle stays stable. */
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
