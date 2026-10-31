import { useLayoutEffect } from 'react'

export function useCombinedDiffScrollPersistence({
  viewportNode,
  updateScrollbar
}: {
  viewportNode: HTMLDivElement | null
  updateScrollbar: () => void
}): void {
  useLayoutEffect(() => {
    const container = viewportNode
    if (!container) {
      return
    }
    const resizeObserver = new ResizeObserver(updateScrollbar)
    resizeObserver.observe(container)
    container.addEventListener('scroll', updateScrollbar, { passive: true })
    updateScrollbar()
    return () => {
      resizeObserver.disconnect()
      container.removeEventListener('scroll', updateScrollbar)
    }
  }, [viewportNode, updateScrollbar])
}
