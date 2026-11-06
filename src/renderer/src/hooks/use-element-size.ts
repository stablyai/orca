import { useCallback, useState } from 'react'

type ElementSize = {
  width: number
  height: number
}

// Measures in the ref callback so the first paint already has a size, including late-mounted elements.
export function useElementSize<T extends HTMLElement>(): {
  ref: (node: T | null) => (() => void) | undefined
  size: ElementSize | null
} {
  const [size, setSize] = useState<ElementSize | null>(null)
  const ref = useCallback((node: T | null) => {
    if (!node) {
      return undefined
    }
    const updateSize = (): void => {
      const rect = node.getBoundingClientRect()
      const width = Math.floor(rect.width)
      const height = Math.floor(rect.height)
      setSize((current) =>
        current?.width === width && current.height === height ? current : { width, height }
      )
    }
    let frameId: number | null = null
    // Deferred so a resize caused by this update can't trip the ResizeObserver loop limit.
    const observer = new ResizeObserver(() => {
      if (frameId !== null) {
        cancelAnimationFrame(frameId)
      }
      frameId = requestAnimationFrame(() => {
        frameId = null
        updateSize()
      })
    })
    updateSize()
    observer.observe(node)
    return () => {
      if (frameId !== null) {
        cancelAnimationFrame(frameId)
      }
      observer.disconnect()
      setSize(null)
    }
  }, [])

  return { ref, size }
}
