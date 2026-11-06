import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'

const DEFAULT_CHECK_DETAILS_HEIGHT = 260
const MIN_CHECK_DETAILS_HEIGHT = 72
const MAX_CHECK_DETAILS_HEIGHT = 520

export function clampCheckDetailsHeight(height: number): number {
  return Math.min(MAX_CHECK_DETAILS_HEIGHT, Math.max(MIN_CHECK_DETAILS_HEIGHT, height))
}

export function useCheckDetailsResize(enabled: boolean): {
  detailsHeight: number
  handleResizeStart: (event: ReactMouseEvent<HTMLDivElement>) => void
} {
  const [detailsHeight, setDetailsHeight] = useState(DEFAULT_CHECK_DETAILS_HEIGHT)
  const dragStartRef = useRef<{ y: number; height: number } | null>(null)

  const handleResizeStart = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      if (!enabled) {
        return
      }
      event.preventDefault()
      dragStartRef.current = { y: event.clientY, height: detailsHeight }
    },
    [detailsHeight, enabled]
  )

  useEffect(() => {
    const handleMouseMove = (event: MouseEvent): void => {
      const dragStart = dragStartRef.current
      if (!dragStart) {
        return
      }
      setDetailsHeight(clampCheckDetailsHeight(dragStart.height + event.clientY - dragStart.y))
    }

    const handleMouseUp = (): void => {
      dragStartRef.current = null
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [])

  return { detailsHeight, handleResizeStart }
}
