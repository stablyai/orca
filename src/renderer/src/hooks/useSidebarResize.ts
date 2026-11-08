import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

export type SidebarRailSnap = {
  isRail: boolean
  railWidth: number
  threshold: number
  setRail: (rail: boolean) => void
}

type UseSidebarResizeOptions = {
  isOpen: boolean
  width: number
  minWidth: number
  maxWidth: number
  deltaSign: 1 | -1
  renderedExtraWidth?: number
  setWidth: (width: number) => void
  onDraftWidthChange?: (width: number) => void
  railSnap?: SidebarRailSnap
}

type UseSidebarResizeResult<T extends HTMLElement> = {
  containerRef: React.RefObject<T | null>
  isResizing: boolean
  isRailRendered: boolean
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

export function resolveSidebarRailDrag({
  pointerWidth,
  threshold,
  minWidth,
  maxWidth
}: {
  pointerWidth: number
  threshold: number
  minWidth: number
  maxWidth: number
}): { rail: true } | { rail: false; width: number } {
  if (pointerWidth < threshold) {
    return { rail: true }
  }
  return { rail: false, width: clampSidebarResizeWidth(pointerWidth, minWidth, maxWidth) }
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
  railSnap
}: UseSidebarResizeOptions): UseSidebarResizeResult<T> {
  const isRail = railSnap?.isRail === true
  const railWidth = railSnap?.railWidth ?? 0
  const containerRef = useRef<T | null>(null)
  const isResizingRef = useRef(false)
  const startXRef = useRef(0)
  const startWidthRef = useRef(width)
  const draftWidthRef = useRef(width)
  const frameRef = useRef<number | null>(null)
  const overlayRef = useRef<HTMLDivElement | null>(null)
  const [isResizing, setIsResizing] = useState(false)
  const draftRailRef = useRef(isRail)
  const [draftRail, setDraftRail] = useState(isRail)

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

      // Keep live drag width out of React props so unrelated renders cannot reset it to the persisted width.
      container.style.width = getRenderedSidebarWidthCssValue(isOpen, nextWidth, renderedExtraWidth)
    },
    [isOpen, renderedExtraWidth]
  )

  useLayoutEffect(() => {
    if (isResizingRef.current) {
      return
    }

    draftWidthRef.current = width
    draftRailRef.current = isRail
    const renderedWidth = isRail ? railWidth : width
    applyRenderedWidth(renderedWidth)
    onDraftWidthChange?.(renderedWidth)
  }, [applyRenderedWidth, onDraftWidthChange, width, isRail, railWidth])

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
    const finalRail = draftRailRef.current
    const renderedWidth = finalRail ? railWidth : finalWidth
    applyRenderedWidth(renderedWidth)
    onDraftWidthChange?.(renderedWidth)
    if (!finalRail && finalWidth !== width) {
      setWidth(finalWidth)
    }
    if (railSnap && finalRail !== railSnap.isRail) {
      railSnap.setRail(finalRail)
    }
  }, [
    applyRenderedWidth,
    onDraftWidthChange,
    railSnap,
    railWidth,
    resetDocumentStyles,
    setWidth,
    width
  ])

  const handleMouseMove = useCallback(
    (event: MouseEvent) => {
      if (!isResizingRef.current) {
        return
      }

      let nextWidth = draftWidthRef.current
      let nextRail = false
      if (railSnap) {
        const resolved = resolveSidebarRailDrag({
          pointerWidth: startWidthRef.current + (event.clientX - startXRef.current) * deltaSign,
          threshold: railSnap.threshold,
          minWidth,
          maxWidth
        })
        nextRail = resolved.rail
        if (!resolved.rail) {
          nextWidth = resolved.width
        }
      } else {
        nextWidth = getNextSidebarResizeWidth({
          clientX: event.clientX,
          startX: startXRef.current,
          startWidth: startWidthRef.current,
          deltaSign,
          minWidth,
          maxWidth
        })
      }
      if (nextWidth === draftWidthRef.current && nextRail === draftRailRef.current) {
        return
      }

      draftWidthRef.current = nextWidth
      if (nextRail !== draftRailRef.current) {
        draftRailRef.current = nextRail
        setDraftRail(nextRail)
      }
      if (frameRef.current !== null) {
        return
      }

      frameRef.current = window.requestAnimationFrame(() => {
        frameRef.current = null
        const renderedWidth = draftRailRef.current ? railWidth : draftWidthRef.current
        applyRenderedWidth(renderedWidth)
        onDraftWidthChange?.(renderedWidth)
      })
    },
    [applyRenderedWidth, deltaSign, maxWidth, minWidth, onDraftWidthChange, railSnap, railWidth]
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
      startWidthRef.current = isRail ? railWidth : width
      draftWidthRef.current = width
      draftRailRef.current = isRail
      setDraftRail(isRail)
      onDraftWidthChange?.(isRail ? railWidth : width)
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'

      // A viewport overlay captures mouseup over native plugins such as PDF embeds, preventing a stuck resize.
      if (!overlayRef.current) {
        const overlay = document.createElement('div')
        overlay.style.position = 'fixed'
        overlay.style.inset = '0'
        overlay.style.zIndex = '2147483647'
        overlay.style.cursor = 'col-resize'
        overlay.style.background = 'transparent'
        document.body.appendChild(overlay)
        overlayRef.current = overlay
      }
    },
    [isRail, onDraftWidthChange, railWidth, width]
  )

  return {
    containerRef,
    isResizing,
    isRailRendered: isResizing ? draftRail : isRail,
    onResizeStart
  }
}
