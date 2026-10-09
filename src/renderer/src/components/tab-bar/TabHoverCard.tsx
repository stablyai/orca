import { useCallback, useContext, useId, useRef, type ReactNode } from 'react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  TabCardOpenContext,
  TabCardPlacementContext,
  TAB_TOOLTIP_SKIP_DELAY_MS
} from './TabStripTooltipProvider'

export function TabHoverCard({
  children,
  title,
  icon,
  programName,
  description
}: {
  children: ReactNode
  title: string
  icon: ReactNode
  programName: string
  description?: string
}): React.JSX.Element {
  const placement = useContext(TabCardPlacementContext)
  const content = useRef<HTMLDivElement>(null)
  const cardId = useId()
  const openContext = useContext(TabCardOpenContext)
  const notifyOpenChange = openContext?.onOpenChange

  const captureClosedPlacement = useCallback(
    (element: HTMLDivElement | null) => {
      const previous = placement?.current
      if (!element || previous?.element !== element) {
        return
      }
      const { left, top } = element.getBoundingClientRect()
      previous.left = left
      previous.top = top
      previous.closedAt = performance.now()
    },
    [placement]
  )

  const setContentElement = useCallback(
    (element: HTMLDivElement | null) => {
      const previous = content.current
      if (element) {
        // StrictMode reattaches refs without closing the tooltip.
        notifyOpenChange?.(cardId, true)
      } else if (previous) {
        notifyOpenChange?.(cardId, false)
        captureClosedPlacement(previous)
      }
      content.current = element
    },
    [captureClosedPlacement, cardId, notifyOpenChange]
  )

  const handlePlaced = (): void => {
    const element = content.current
    if (!element || !placement) {
      return
    }
    const rect = element.getBoundingClientRect()
    const previous = placement.current
    if (
      previous &&
      previous.closedAt !== null &&
      performance.now() - previous.closedAt < TAB_TOOLTIP_SKIP_DELAY_MS &&
      !window.matchMedia('(prefers-reduced-motion: reduce)').matches
    ) {
      // Continue from the painted position when reversing direction during a slide.
      const origin = previous.element.isConnected
        ? previous.element.getBoundingClientRect()
        : previous
      element.animate(
        [
          { translate: `${origin.left - rect.left}px ${origin.top - rect.top}px`, opacity: 1 },
          { translate: '0 0', opacity: 1 }
        ],
        { duration: 150, easing: 'ease-out' }
      )
    }
    placement.current = { element, left: rect.left, top: rect.top, closedAt: null }
  }

  return (
    <Tooltip
      delayDuration={openContext?.isWarm ? 0 : undefined}
      onOpenChange={(open) => {
        openContext?.onOpenChange(cardId, open)
        if (!open && content.current?.isConnected) {
          captureClosedPlacement(content.current)
        }
      }}
    >
      <TooltipTrigger
        asChild
        onFocus={(event) => {
          // Nested controls own their focus hints.
          if (event.target !== event.currentTarget) {
            event.preventDefault()
          }
        }}
      >
        {children}
      </TooltipTrigger>
      <TooltipContent
        ref={setContentElement}
        variant="tab-preview"
        showArrow={false}
        side="bottom"
        align="start"
        sideOffset={0}
        onPlaced={handlePlaced}
        data-tab-hover-card="true"
      >
        <div className="space-y-2 text-left">
          <div className="space-y-1">
            <div className="break-words font-medium" data-tab-hover-card-title>
              {title}
            </div>
            {description && <div className="break-all text-muted-foreground">{description}</div>}
          </div>
          <div
            className="flex items-center gap-2 text-muted-foreground"
            data-tab-hover-card-program
          >
            <span className="flex size-4 shrink-0 items-center justify-center" aria-hidden>
              {icon}
            </span>
            <span className="min-w-0 break-all">{programName}</span>
          </div>
        </div>
      </TooltipContent>
    </Tooltip>
  )
}
