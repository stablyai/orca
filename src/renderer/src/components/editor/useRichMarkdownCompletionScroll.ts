import { useEffect, useRef, type RefObject } from 'react'

export function useRichMarkdownCompletionScroll(
  selectedIndex: number,
  rows: readonly unknown[]
): {
  viewportRef: RefObject<HTMLDivElement | null>
  activeItemRef: RefObject<HTMLButtonElement | null>
} {
  const viewportRef = useRef<HTMLDivElement>(null)
  const activeItemRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    const viewport = viewportRef.current
    const item = activeItemRef.current
    if (!viewport || !item) {
      return
    }
    const top = item.offsetTop
    const bottom = top + item.offsetHeight
    if (top < viewport.scrollTop) {
      viewport.scrollTop = top
    } else if (bottom > viewport.scrollTop + viewport.clientHeight) {
      viewport.scrollTop = bottom - viewport.clientHeight
    }
  }, [selectedIndex, rows])

  return { viewportRef, activeItemRef }
}
