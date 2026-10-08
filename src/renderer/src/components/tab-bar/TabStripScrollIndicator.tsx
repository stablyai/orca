import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { computeTabStripThumbLayout } from './tab-strip-scroll-metrics'

export type TabStripScrollIndicatorProps = {
  hasOverflow: boolean
  scrollContainerRef?: React.RefObject<HTMLElement | null>
  /** Called when tabs change the strip's size without a scroll event; returns an unsubscribe. */
  subscribeToStripResize?: (listener: () => void) => () => void
  disabled?: boolean
}

export function TabStripScrollIndicator({
  hasOverflow,
  scrollContainerRef,
  subscribeToStripResize,
  disabled = false
}: TabStripScrollIndicatorProps): React.JSX.Element | null {
  const trackRef = useRef<HTMLDivElement>(null)
  const thumbRef = useRef<HTMLDivElement>(null)
  const cleanupDragRef = useRef<(() => void) | null>(null)
  const [isHovered, setIsHovered] = useState(false)
  const [isDragging, setIsDragging] = useState(false)
  const [isScrolling, setIsScrolling] = useState(false)
  const scrollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Why write the thumb's style directly: it moves every scroll frame, and React state would re-render per frame.
  useLayoutEffect(() => {
    const track = trackRef.current
    const thumb = thumbRef.current
    const scrollContainer = scrollContainerRef?.current
    if (!track || !thumb || !scrollContainer) {
      return
    }
    const syncThumb = (): void => {
      const layout = computeTabStripThumbLayout(track.clientWidth, scrollContainer)
      thumb.style.width = `${layout.widthPx}px`
      thumb.style.transform = `translateX(${layout.leftPx}px)`
    }
    syncThumb()
    scrollContainer.addEventListener('scroll', syncThumb, { passive: true })
    const trackResizeObserver = new ResizeObserver(syncThumb)
    trackResizeObserver.observe(track)
    const unsubscribeStripResize = subscribeToStripResize?.(syncThumb)
    return () => {
      scrollContainer.removeEventListener('scroll', syncThumb)
      trackResizeObserver.disconnect()
      unsubscribeStripResize?.()
    }
  }, [hasOverflow, scrollContainerRef, subscribeToStripResize])

  useEffect(() => {
    const scrollContainer = scrollContainerRef?.current
    if (!scrollContainer) {
      return
    }
    const handleScroll = (): void => {
      setIsScrolling(true)
      if (scrollTimeoutRef.current) {
        clearTimeout(scrollTimeoutRef.current)
      }
      scrollTimeoutRef.current = setTimeout(() => {
        setIsScrolling(false)
      }, 800)
    }
    scrollContainer.addEventListener('scroll', handleScroll, { passive: true })
    return () => {
      scrollContainer.removeEventListener('scroll', handleScroll)
      if (scrollTimeoutRef.current) {
        clearTimeout(scrollTimeoutRef.current)
      }
    }
  }, [scrollContainerRef])

  useEffect(() => {
    return () => {
      cleanupDragRef.current?.()
    }
  }, [])

  // Why: hiding the indicator mid-drag would otherwise leave window listeners and body cursor/user-select stuck.
  useEffect(() => {
    if (disabled || !hasOverflow) {
      cleanupDragRef.current?.()
    }
  }, [disabled, hasOverflow])

  const handleThumbPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0 || disabled) {
      return
    }
    e.preventDefault()
    e.stopPropagation()

    const scrollContainer = scrollContainerRef?.current
    const track = trackRef.current
    if (!scrollContainer || !track) {
      return
    }

    const startX = e.clientX
    const startScrollLeft = scrollContainer.scrollLeft
    const trackWidth = track.clientWidth
    const thumbWidth = computeTabStripThumbLayout(trackWidth, scrollContainer).widthPx
    const maxLeft = Math.max(1, trackWidth - thumbWidth)
    const maxScrollLeft = Math.max(0, scrollContainer.scrollWidth - scrollContainer.clientWidth)

    if (maxScrollLeft <= 0 || maxLeft <= 0) {
      return
    }

    setIsDragging(true)
    const prevUserSelect = document.body.style.userSelect
    const prevCursor = document.body.style.cursor
    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'grabbing'

    const onPointerMove = (moveEvent: PointerEvent): void => {
      const deltaX = moveEvent.clientX - startX
      const scrollDelta = (deltaX / maxLeft) * maxScrollLeft
      scrollContainer.scrollLeft = Math.max(
        0,
        Math.min(maxScrollLeft, startScrollLeft + scrollDelta)
      )
    }

    const cleanup = (): void => {
      setIsDragging(false)
      document.body.style.userSelect = prevUserSelect
      document.body.style.cursor = prevCursor
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', cleanup)
      window.removeEventListener('pointercancel', cleanup)
      cleanupDragRef.current = null
    }

    cleanupDragRef.current = cleanup
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', cleanup)
    window.addEventListener('pointercancel', cleanup)
  }

  const handleTrackPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0 || disabled) {
      return
    }
    if (e.target !== trackRef.current) {
      return
    }
    e.preventDefault()
    e.stopPropagation()

    const scrollContainer = scrollContainerRef?.current
    const track = trackRef.current
    if (!scrollContainer || !track) {
      return
    }

    const trackRect = track.getBoundingClientRect()
    const clickX = e.clientX - trackRect.left
    const trackWidth = track.clientWidth
    const thumbWidth = computeTabStripThumbLayout(trackWidth, scrollContainer).widthPx
    const maxLeft = Math.max(1, trackWidth - thumbWidth)
    const maxScrollLeft = Math.max(0, scrollContainer.scrollWidth - scrollContainer.clientWidth)

    if (maxScrollLeft <= 0 || maxLeft <= 0) {
      return
    }

    const targetThumbLeft = Math.max(0, Math.min(maxLeft, clickX - thumbWidth / 2))
    const targetScrollLeft = (targetThumbLeft / maxLeft) * maxScrollLeft

    scrollContainer.scrollTo({
      left: targetScrollLeft,
      behavior: 'smooth'
    })
  }

  const handleWheel = (e: React.WheelEvent<HTMLDivElement>): void => {
    const scrollContainer = scrollContainerRef?.current
    if (!scrollContainer || disabled) {
      return
    }
    // Why: forward wheel events to tab container so scrolling over the indicator scrolls the strip.
    const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY
    scrollContainer.scrollLeft += delta
  }

  if (!hasOverflow) {
    return null
  }

  // Why: during a tab drag the indicator fully yields — no reveal, no pointer/wheel interaction.
  const isExpanded = !disabled && (isHovered || isDragging)
  const isVisible = !disabled && (isHovered || isDragging || isScrolling)

  return (
    // Why: under-tab position matches editor tab scrollbar conventions, auto-hiding when idle so it never mimics an underline.
    <div
      ref={trackRef}
      data-testid="tab-strip-scroll-indicator"
      className={`absolute inset-x-0 bottom-0 z-[12] select-none transition-[height,background-color,opacity] duration-150 ease-out ${
        isExpanded ? 'h-[4px] bg-muted-foreground/15 cursor-pointer' : 'h-[3px] bg-transparent'
      } ${
        disabled
          ? 'opacity-0 pointer-events-none'
          : isVisible
            ? 'opacity-100 pointer-events-auto'
            : 'opacity-0 group-hover/tab-strip:opacity-100 pointer-events-none group-hover/tab-strip:pointer-events-auto'
      }`}
      onPointerEnter={() => setIsHovered(true)}
      onPointerLeave={() => setIsHovered(false)}
      onPointerDown={handleTrackPointerDown}
      onWheel={handleWheel}
      // Why: decorative rail — keyboard/AT users scroll the strip with the adjacent labelled scroll buttons.
      aria-hidden
    >
      <div
        ref={thumbRef}
        data-testid="tab-strip-scroll-thumb"
        className={`absolute bottom-0 left-0 h-full rounded-full will-change-transform transition-colors duration-150 ease-out ${
          isDragging
            ? 'bg-foreground/70 cursor-grabbing'
            : isHovered
              ? 'bg-muted-foreground/80 cursor-grab'
              : 'bg-muted-foreground/60 cursor-default'
        }`}
        onPointerDown={handleThumbPointerDown}
      />
    </div>
  )
}
