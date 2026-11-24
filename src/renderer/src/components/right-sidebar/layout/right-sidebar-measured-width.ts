import { useCallback, useRef } from 'react'

export function useMeasuredWidth(onWidth: (width: number | null) => void) {
  const observerRef = useRef<ResizeObserver | null>(null)
  const widthRef = useRef<number | null>(null)

  return useCallback(
    (node: HTMLDivElement | null) => {
      observerRef.current?.disconnect()
      observerRef.current = null

      const commitWidth = (width: number | null): void => {
        if (Object.is(widthRef.current, width)) {
          return
        }
        widthRef.current = width
        onWidth(width)
      }

      if (!node || typeof ResizeObserver === 'undefined') {
        commitWidth(node ? node.getBoundingClientRect().width : null)
        return
      }

      const updateWidth = (): void => {
        commitWidth(node.getBoundingClientRect().width)
      }
      updateWidth()
      const observer = new ResizeObserver(updateWidth)
      observer.observe(node)
      observerRef.current = observer
    },
    [onWidth]
  )
}
