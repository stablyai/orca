import React, { useCallback, useState } from 'react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

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
}

export function TruncatedSidebarLabel({
  text,
  className,
  tooltipEnabled = true,
  tooltipSide = 'right',
  tooltipSideOffset = 8
}: TruncatedSidebarLabelProps): React.JSX.Element {
  const resizeObserverRef = React.useRef<ResizeObserver | null>(null)
  const removeResizeListenerRef = React.useRef<(() => void) | null>(null)
  const [truncated, setTruncated] = useState(false)

  const measureTruncated = useCallback((element: HTMLSpanElement | null) => {
    const nextTruncated = element ? isSidebarLabelTruncated(element) : false
    setTruncated((current) => (current === nextTruncated ? current : nextTruncated))
  }, [])

  const handleRef = useCallback(
    (node: HTMLSpanElement | null): void => {
      resizeObserverRef.current?.disconnect()
      resizeObserverRef.current = null
      removeResizeListenerRef.current?.()
      removeResizeListenerRef.current = null

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

  const label = (
    <span
      // Why: ResizeObserver does not fire when only the rendered text changes,
      // but scrollWidth can; remount so branch reuse remeasures immediately.
      key={text}
      ref={handleRef}
      className={cn('block min-w-0 truncate', className)}
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
