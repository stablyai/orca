import { useEffect, useState, type RefObject } from 'react'

export type AgentMapCanvasSize = { width: number; height: number }

export function useAgentMapCanvasSize(
  containerRef: RefObject<HTMLDivElement | null>,
  onResize: () => void
): AgentMapCanvasSize {
  const [size, setSize] = useState<AgentMapCanvasSize>({ width: 800, height: 560 })

  useEffect(() => {
    const container = containerRef.current
    if (!container || typeof ResizeObserver === 'undefined') {
      return
    }
    const measure = (): void => {
      const next = container.getBoundingClientRect()
      if (next.width <= 0 || next.height <= 0) {
        return
      }
      onResize()
      setSize((current) =>
        current.width === next.width && current.height === next.height
          ? current
          : { width: next.width, height: next.height }
      )
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(container)
    return () => observer.disconnect()
  }, [containerRef, onResize])

  return size
}
