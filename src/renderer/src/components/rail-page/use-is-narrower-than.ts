import { useLayoutEffect, useState } from 'react'

export function useIsNarrowerThan(
  ref: React.RefObject<HTMLElement | null>,
  widthPx: number
): boolean {
  const [narrow, setNarrow] = useState(false)
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) {
      return
    }
    const measure = (): void => {
      const next = element.getBoundingClientRect().width < widthPx
      setNarrow((current) => (current === next ? current : next))
    }
    measure()
    if (typeof ResizeObserver === 'undefined') {
      return
    }
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [ref, widthPx])
  return narrow
}
