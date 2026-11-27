import { useLayoutEffect, type RefObject } from 'react'

/**
 * Reports the shown hint's height: a wrapped hint is taller than one line, and its placement needs the real
 * height to stay on the page. Observed, so a pane resize that rewraps it is measured too.
 */
export function usePaletteHintHeight(
  hintRef: RefObject<HTMLElement | null>,
  shown: boolean,
  onHeight: (height: number) => void
): void {
  useLayoutEffect(() => {
    const element = hintRef.current
    if (!shown || !element) {
      return
    }
    const measure = (): void => {
      if (element.offsetHeight) {
        onHeight(element.offsetHeight)
      }
    }
    measure()
    if (typeof ResizeObserver === 'undefined') {
      return
    }
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [hintRef, onHeight, shown])
}
