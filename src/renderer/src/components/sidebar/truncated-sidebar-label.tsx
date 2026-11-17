import React, { useCallback, useLayoutEffect, useState } from 'react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/class-names'

export function isSidebarLabelTruncated(
  element: Pick<HTMLElement, 'clientWidth' | 'scrollWidth'>
): boolean {
  return element.scrollWidth > element.clientWidth
}

type TruncatedSidebarLabelProps = {
  text: string
  className?: string
  tooltipEnabled?: boolean
  tooltipSide?: 'top' | 'right' | 'bottom' | 'left'
  tooltipSideOffset?: number
  /** dsh session-row behavior: hovering a truncated label scrolls it to its
   *  far edge and reveals the full text; leaving returns it to the start. */
  scrollOnHover?: boolean
}

export function TruncatedSidebarLabel({
  text,
  className,
  tooltipEnabled = true,
  tooltipSide = 'right',
  tooltipSideOffset = 8,
  scrollOnHover = false
}: TruncatedSidebarLabelProps): React.JSX.Element {
  const nodeRef = React.useRef<HTMLSpanElement | null>(null)
  const resizeObserverRef = React.useRef<ResizeObserver | null>(null)
  const removeResizeListenerRef = React.useRef<(() => void) | null>(null)
  const [truncated, setTruncated] = useState(false)

  const measureTruncated = useCallback((element: HTMLSpanElement | null) => {
    const nextTruncated = element ? isSidebarLabelTruncated(element) : false
    setTruncated((current) => (current === nextTruncated ? current : nextTruncated))
  }, [])

  const scrollToEdge = useCallback(
    (edge: 'start' | 'end') => {
      const node = nodeRef.current
      if (!node || !scrollOnHover || !isSidebarLabelTruncated(node)) {
        return
      }
      const left = edge === 'end' ? node.scrollWidth : 0
      // Why: happy-dom and older engines lack scrollTo; direct assignment
      // scrolls identically for an overflow-hidden label.
      if (typeof node.scrollTo === 'function') {
        const reduceMotion =
          typeof window.matchMedia === 'function' &&
          window.matchMedia('(prefers-reduced-motion: reduce)').matches
        node.scrollTo({ left, behavior: reduceMotion ? 'auto' : 'smooth' })
        return
      }
      node.scrollLeft = left
    },
    [scrollOnHover]
  )

  const handleRef = useCallback(
    (node: HTMLSpanElement | null): void => {
      resizeObserverRef.current?.disconnect()
      resizeObserverRef.current = null
      removeResizeListenerRef.current?.()
      removeResizeListenerRef.current = null

      nodeRef.current = node
      if (!node) {
        measureTruncated(null)
        return
      }

      measureTruncated(node)
      const updateTruncated = () => measureTruncated(node)
      if (typeof ResizeObserver === 'undefined') {
        window.addEventListener('resize', updateTruncated)
        removeResizeListenerRef.current = () =>
          window.removeEventListener('resize', updateTruncated)
        return
      }

      const observer = new ResizeObserver(updateTruncated)
      observer.observe(node)
      resizeObserverRef.current = observer
    },
    [measureTruncated]
  )

  // Text can change scrollWidth without firing ResizeObserver; remeasure without remounting the observer.
  useLayoutEffect(() => {
    measureTruncated(nodeRef.current)
  }, [measureTruncated, text])

  const label = (
    <span
      ref={handleRef}
      className={cn('block min-w-0 truncate', className)}
      onMouseEnter={scrollOnHover ? () => scrollToEdge('end') : undefined}
      onMouseLeave={scrollOnHover ? () => scrollToEdge('start') : undefined}
    >
      {text}
    </span>
  )

  if (!tooltipEnabled || !truncated) {
    return label
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>{label}</TooltipTrigger>
      <TooltipContent
        side={tooltipSide}
        sideOffset={tooltipSideOffset}
        className="max-w-80 whitespace-normal break-all text-left"
      >
        {text}
      </TooltipContent>
    </Tooltip>
  )
}
