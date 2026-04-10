import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

const SIDEBAR_TOGGLE_ANIMATION_MS = 200

export type SidebarContentAnimationState = 'opening' | 'open' | 'closing' | 'closed'

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
  renderedOpen: boolean
  contentAnimationState: SidebarContentAnimationState
}

export function clampSidebarResizeWidth(width: number, minWidth: number, maxWidth: number): number {
  return Math.min(maxWidth, Math.max(minWidth, width))
}

export function getRenderedSidebarWidthCssValue(
  isOpen: boolean,
  width: number,
  renderedExtraWidth: number
): string {
  return `${getRenderedSidebarWidthPx(isOpen, width, renderedExtraWidth)}px`
}

export function getRenderedSidebarWidthPx(
  isOpen: boolean,
  width: number,
  renderedExtraWidth: number
): number {
  return isOpen ? width + renderedExtraWidth : 0
}

export function interpolateSidebarAnimationWidth(
  startWidth: number,
  endWidth: number,
  progress: number
): number {
  const clampedProgress = Math.min(1, Math.max(0, progress))
  const easedProgress =
    clampedProgress < 0.5
      ? 4 * clampedProgress * clampedProgress * clampedProgress
      : 1 - Math.pow(-2 * clampedProgress + 2, 3) / 2
  return startWidth + (endWidth - startWidth) * easedProgress
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
  const closeTimerRef = useRef<number | null>(null)
  const openFrameRef = useRef<number | null>(null)
  const [isResizing, setIsResizing] = useState(false)
  const [renderedOpen, setRenderedOpen] = useState(isOpen)
  const [contentAnimationState, setContentAnimationState] = useState<SidebarContentAnimationState>(
    isOpen ? 'open' : 'closed'
  )

  const resetDocumentStyles = useCallback(() => {
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
  }, [])

  const applyRenderedWidth = useCallback(
    (nextWidth: number, nextIsOpen: boolean = renderedOpen) => {
      const container = containerRef.current
      if (!container) {
        return
      }

      // Why: sidebar containers intentionally keep live drag width out of
      // React props. Any unrelated rerender during a drag would otherwise
      // snap the DOM width back to the last persisted store value and make the
      // handle feel like it is lagging behind the pointer.
      container.style.width = getRenderedSidebarWidthCssValue(
        nextIsOpen,
        nextWidth,
        renderedExtraWidth
      )
    },
    [renderedOpen, renderedExtraWidth]
  )

  useLayoutEffect(() => {
    if (isResizingRef.current) {
      return
    }

    draftWidthRef.current = width
    applyRenderedWidth(width)
  }, [applyRenderedWidth, width])

  useEffect(() => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current)
      closeTimerRef.current = null
    }
    if (openFrameRef.current !== null) {
      cancelAnimationFrame(openFrameRef.current)
      openFrameRef.current = null
    }

    if (isOpen) {
      setRenderedOpen(true)
      setContentAnimationState((current) => (current === 'open' ? current : 'opening'))
      // Why: opening reserves the layout width immediately so the terminal
      // resizes once, then animates only the sidebar's inner content. This
      // avoids the terminal blanking seen during continuous shell-width
      // animation while still giving the sidebar a smooth visual transition.
      openFrameRef.current = window.requestAnimationFrame(() => {
        openFrameRef.current = null
        setContentAnimationState('open')
      })
      return
    }

    setContentAnimationState((current) => (current === 'closed' ? current : 'closing'))
    // Why: keep the sidebar's layout width alive during the exit animation so
    // the user sees content slide/fade away first, then release the space at
    // the end. The terminal only snaps once when the sidebar is fully gone.
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = null
      setRenderedOpen(false)
      setContentAnimationState('closed')
    }, SIDEBAR_TOGGLE_ANIMATION_MS)

    return () => {
      if (closeTimerRef.current !== null) {
        window.clearTimeout(closeTimerRef.current)
        closeTimerRef.current = null
      }
      if (openFrameRef.current !== null) {
        cancelAnimationFrame(openFrameRef.current)
        openFrameRef.current = null
      }
    }
  }, [isOpen])

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

      if (closeTimerRef.current !== null) {
        window.clearTimeout(closeTimerRef.current)
        closeTimerRef.current = null
      }
      if (openFrameRef.current !== null) {
        cancelAnimationFrame(openFrameRef.current)
        openFrameRef.current = null
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

  return { containerRef, isResizing, onResizeStart, renderedOpen, contentAnimationState }
}
