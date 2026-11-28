import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

type UseSidebarResizeOptions<T extends HTMLElement> = {
  isOpen: boolean
  width: number
  minWidth: number
  maxWidth: number
  deltaSign: 1 | -1
  renderedExtraWidth?: number
  setWidth: (width: number) => void
  onDraftWidthChange?: (width: number) => void
  /** 'y' resizes a stacked section's height; `width` options then mean height. */
  axis?: 'x' | 'y'
  /** Content-sized sections start a drag from what is on screen, not the saved size. */
  measureStartSize?: (container: T) => number
  /** Read at drag start from live layout, so the limit never trails the space actually free. */
  measureMaxSize?: (container: T) => number
  /** Map pointer travel in local CSS pixels back to a saved width for non-linear layouts. */
  measureWidthFromDelta?: (
    container: T,
    startWidth: number
  ) => ((delta: number) => number) | undefined
  applyRenderedSize?: (container: T, size: number) => void
  /** Every drag's end, after the final size is applied and before `setWidth`: the size the drag
   *  ended at, or null when it ended where it started. `setWidth` alone skips a drag that ends at the
   *  current size. */
  onResizeEnd?: (movedTo: number | null) => void
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

export function useSidebarResize<T extends HTMLElement>({
  isOpen,
  width,
  minWidth,
  maxWidth,
  deltaSign,
  renderedExtraWidth = 0,
  setWidth,
  onDraftWidthChange,
  axis = 'x',
  measureStartSize,
  measureMaxSize,
  measureWidthFromDelta,
  applyRenderedSize,
  onResizeEnd
}: UseSidebarResizeOptions<T>): UseSidebarResizeResult<T> {
  const containerRef = useRef<T | null>(null)
  const isResizingRef = useRef(false)
  const startXRef = useRef(0)
  const dragZoomRef = useRef(1)
  const widthFromDeltaRef = useRef<((delta: number) => number) | undefined>(undefined)
  const startWidthRef = useRef(width)
  const draftWidthRef = useRef(width)
  const measuredMaxWidthRef = useRef<number | null>(null)
  const frameRef = useRef<number | null>(null)
  const overlayRef = useRef<HTMLDivElement | null>(null)
  const [isResizing, setIsResizing] = useState(false)

  const removeDragOverlay = useCallback(() => {
    const overlay = overlayRef.current
    if (overlay && overlay.parentNode) {
      overlay.parentNode.removeChild(overlay)
    }
    overlayRef.current = null
  }, [])

  const resetDocumentStyles = useCallback(() => {
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
    removeDragOverlay()
  }, [removeDragOverlay])

  const applyRenderedWidth = useCallback(
    (nextWidth: number) => {
      const container = containerRef.current
      if (!container) {
        return
      }

      if (applyRenderedSize) {
        applyRenderedSize(container, nextWidth)
        return
      }
      // Keep live drag width out of React props so unrelated renders cannot reset it to the persisted width.
      container.style.width = getRenderedSidebarWidthCssValue(isOpen, nextWidth, renderedExtraWidth)
    },
    [applyRenderedSize, isOpen, renderedExtraWidth]
  )

  useLayoutEffect(() => {
    if (isResizingRef.current) {
      return
    }

    draftWidthRef.current = width
    applyRenderedWidth(width)
    onDraftWidthChange?.(width)
  }, [applyRenderedWidth, onDraftWidthChange, width])

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

    // A press without movement (or a double-click) must not save the measured start size.
    const moved = draftWidthRef.current !== startWidthRef.current
    const finalWidth = moved ? draftWidthRef.current : width
    applyRenderedWidth(finalWidth)
    onDraftWidthChange?.(finalWidth)
    onResizeEnd?.(moved ? finalWidth : null)
    if (finalWidth !== width) {
      setWidth(finalWidth)
    }
  }, [applyRenderedWidth, onDraftWidthChange, onResizeEnd, resetDocumentStyles, setWidth, width])

  const handleMouseMove = useCallback(
    (event: MouseEvent) => {
      if (!isResizingRef.current) {
        return
      }

      const position = (axis === 'y' ? event.clientY : event.clientX) / dragZoomRef.current
      const delta = (position - startXRef.current) * deltaSign
      const nextWidth = clampSidebarResizeWidth(
        widthFromDeltaRef.current?.(delta) ?? startWidthRef.current + delta,
        minWidth,
        measuredMaxWidthRef.current ?? maxWidth
      )
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
        onDraftWidthChange?.(draftWidthRef.current)
      })
    },
    [applyRenderedWidth, axis, deltaSign, maxWidth, minWidth, onDraftWidthChange]
  )

  // Stable listeners read the latest handlers, so a re-render mid-drag neither tears the gesture down nor leaves it on stale props.
  const dragHandlersRef = useRef({ move: handleMouseMove, stop: stopResize })
  useLayoutEffect(() => {
    dragHandlersRef.current = { move: handleMouseMove, stop: stopResize }
  })

  useEffect(() => {
    const onWindowMouseMove = (event: MouseEvent): void => dragHandlersRef.current.move(event)
    const onWindowStop = (): void => dragHandlersRef.current.stop()
    window.addEventListener('mousemove', onWindowMouseMove)
    window.addEventListener('mouseup', onWindowStop)
    window.addEventListener('blur', onWindowStop)

    return () => {
      window.removeEventListener('mousemove', onWindowMouseMove)
      window.removeEventListener('mouseup', onWindowStop)
      window.removeEventListener('blur', onWindowStop)

      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current)
        frameRef.current = null
      }

      isResizingRef.current = false
      resetDocumentStyles()
    }
  }, [resetDocumentStyles])

  const onResizeStart = useCallback(
    (event: React.MouseEvent) => {
      event.preventDefault()
      const container = containerRef.current
      const startWidth = container && measureStartSize ? measureStartSize(container) : width
      widthFromDeltaRef.current = container
        ? measureWidthFromDelta?.(container, startWidth)
        : undefined
      measuredMaxWidthRef.current = container && measureMaxSize ? measureMaxSize(container) : null
      const cursor = axis === 'y' ? 'row-resize' : 'col-resize'
      isResizingRef.current = true
      setIsResizing(true)
      dragZoomRef.current = container?.currentCSSZoom || 1
      startXRef.current = (axis === 'y' ? event.clientY : event.clientX) / dragZoomRef.current
      startWidthRef.current = startWidth
      draftWidthRef.current = startWidth
      onDraftWidthChange?.(startWidth)
      document.body.style.cursor = cursor
      document.body.style.userSelect = 'none'

      // A viewport overlay captures mouseup over native plugins such as PDF embeds, preventing a stuck resize.
      if (!overlayRef.current) {
        const overlay = document.createElement('div')
        overlay.style.position = 'fixed'
        overlay.style.inset = '0'
        overlay.style.zIndex = '2147483647'
        overlay.style.cursor = cursor
        overlay.style.background = 'transparent'
        document.body.appendChild(overlay)
        overlayRef.current = overlay
      }
    },
    [axis, measureMaxSize, measureStartSize, measureWidthFromDelta, onDraftWidthChange, width]
  )

  return { containerRef, isResizing, onResizeStart }
}
