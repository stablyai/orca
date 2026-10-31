import { useLayoutEffect } from 'react'
import type React from 'react'
import type { CombinedDiffScrollAnchors } from './use-combined-diff-scroll-anchors'

export function useCombinedDiffScrollPersistence({
  anchors,
  scrollContainerRef,
  updateScrollbar
}: {
  anchors: CombinedDiffScrollAnchors
  scrollContainerRef: React.RefObject<HTMLDivElement | null>
  updateScrollbar: () => void
}): void {
  const { persistScrollAnchor } = anchors
  useLayoutEffect(() => {
    const container = scrollContainerRef.current
    if (!container) {
      return
    }
    const record = (): void => {
      persistScrollAnchor()
      updateScrollbar()
    }
    const resizeObserver = new ResizeObserver(updateScrollbar)
    resizeObserver.observe(container)
    container.addEventListener('scroll', record, { passive: true })
    updateScrollbar()
    return () => {
      record()
      resizeObserver.disconnect()
      container.removeEventListener('scroll', record)
    }
  }, [persistScrollAnchor, scrollContainerRef, updateScrollbar])
}
