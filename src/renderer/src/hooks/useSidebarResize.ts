import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

type UseSidebarResizeOptions = {
  isOpen: boolean
  width: number
  minWidth: number
  maxWidth: number
  deltaSign: 1 | -1
  renderedExtraWidth?: number
  setWidth: (width: number) => void
}

type UseSidebarResizeResult<T extends HTMLElement> = {
  containerRef: React.RefObject<T | null>
  isResizing: boolean
  onResizeStart: (event: React.MouseEvent) => void
}

export function clampSidebarResizeWidth(width: number, minWidth: number, maxWidth: number): number {
  return Math.min(maxWidth, Math.max(minWidth, width))
}

export function getRenderedSidebarWidthCssValue(
  isOpen: boolean,
  width: number,
  renderedExtraWidth: number
): string {
  return isOpen ? `${width + renderedExtraWidth}px` : '0px'
}

export function getNextSidebarResizeWidth({
  clientX,
  startX,
  startWidth,
  deltaSign,
  minWidth,
  maxWidth
}: {
  clientX: number
  startX: number
  startWidth: number
  deltaSign: 1 | -1
  minWidth: number
  maxWidth: number
}): number {
  const delta = (clientX - startX) * deltaSign
  return clampSidebarResizeWidth(startWidth + delta, minWidth, maxWidth)
}

export function useSidebarResize<T extends HTMLElement>({
  isOpen,
  width,
  minWidth,
  maxWidth,
  deltaSign,
  renderedExtraWidth = 0,
  setWidth
}: UseSidebarResizeOptions): UseSidebarResizeResult<T> {
  const containerRef = useRef<T | null>(null)
  const isResizingRef = useRef(false)
  const startXRef = useRef(0)
  const startWidthRef = useRef(width)
  const draftWidthRef = useRef(width)
  const frameRef = useRef<number | null>(null)
  const [isResizing, setIsResizing] = useState(false)

  const resetDocumentStyles = useCallback(() => {
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
  }, [])

  const applyRenderedWidth = useCallback(
    (nextWidth: number) => {
      const container = containerRef.current
      if (!container) {
        return
      }

      // Why: sidebar containers intentionally keep live drag width out of
      // React props. Any unrelated rerender during a drag would otherwise
      // snap the DOM width back to the last persisted store value and make the
      // handle feel like it is lagging behind the pointer.
      container.style.width = getRenderedSidebarWidthCssValue(isOpen, nextWidth, renderedExtraWidth)
    },
    [isOpen, renderedExtraWidth]
  )

  useLayoutEffect(() => {
    if (isResizingRef.current) {
      return
    }

    draftWidthRef.current = width
    applyRenderedWidth(width)
  }, [applyRenderedWidth, width])

  const stopResize = useCallback(() => {
    if (!isResizingRef.current) {
      return
    }

    isResizingRef.current = false
    setIsResizing(false)

    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current)
      frameRef.current = null
    }

    resetDocumentStyles()

    const finalWidth = draftWidthRef.current
    applyRenderedWidth(finalWidth)
    if (finalWidth !== width) {
      setWidth(finalWidth)
    }
  }, [applyRenderedWidth, resetDocumentStyles, setWidth, width])

  const handleMouseMove = useCallback(
    (event: MouseEvent) => {
      if (!isResizingRef.current) {
        return
      }

      const nextWidth = getNextSidebarResizeWidth({
        clientX: event.clientX,
        startX: startXRef.current,
        startWidth: startWidthRef.current,
        deltaSign,
        minWidth,
        maxWidth
      })
      if (nextWidth === draftWidthRef.current) {
        return
      }

      draftWidthRef.current = nextWidth
      if (frameRef.current !== null) {
        return
      }

      frameRef.current = window.requestAnimationFrame(() => {
        frameRef.current = null
        applyRenderedWidth(draftWidthRef.current)
      })
    },
    [applyRenderedWidth, deltaSign, maxWidth, minWidth]
  )

  useEffect(() => {
    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', stopResize)
    window.addEventListener('blur', stopResize)

    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', stopResize)
      window.removeEventListener('blur', stopResize)

      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current)
        frameRef.current = null
      }

      isResizingRef.current = false
      resetDocumentStyles()
    }
  }, [handleMouseMove, resetDocumentStyles, stopResize])

  const onResizeStart = useCallback(
    (event: React.MouseEvent) => {
      event.preventDefault()
      isResizingRef.current = true
      setIsResizing(true)
      startXRef.current = event.clientX
      startWidthRef.current = width
      draftWidthRef.current = width
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'
    },
    [width]
  )

  return { containerRef, isResizing, onResizeStart }
}
