'use client'

import * as React from 'react'
import { Popover as PopoverPrimitive } from 'radix-ui'

import { cn } from '@/lib/utils'

function Popover(props: React.ComponentProps<typeof PopoverPrimitive.Root>) {
  return <PopoverPrimitive.Root data-slot="popover" {...props} />
}

function PopoverTrigger(props: React.ComponentProps<typeof PopoverPrimitive.Trigger>) {
  return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />
}

function PopoverContent({
  className,
  align = 'center',
  sideOffset = 4,
  style,
  onWheel,
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Content>) {
  const handleWheel = React.useCallback(
    (event: React.WheelEvent<HTMLDivElement>) => {
      onWheel?.(event)
      if (event.defaultPrevented) {
        return
      }

      const el = event.currentTarget
      if (!el.classList.contains('popover-scroll-content') || el.scrollHeight <= el.clientHeight) {
        return
      }

      const delta =
        event.deltaMode === WheelEvent.DOM_DELTA_LINE
          ? event.deltaY * 16
          : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
            ? event.deltaY * el.clientHeight
            : event.deltaY
      const maxScrollTop = el.scrollHeight - el.clientHeight
      const nextScrollTop = Math.max(0, Math.min(maxScrollTop, el.scrollTop + delta))

      // Why: issue drawers are Radix dialogs with scroll-lock. These popovers
      // are portaled outside the dialog subtree, so native wheel scrolling is
      // swallowed even though the scrollbar can be dragged.
      if (nextScrollTop !== el.scrollTop) {
        const previousScrollTop = el.scrollTop
        event.stopPropagation()
        requestAnimationFrame(() => {
          if (el.scrollTop === previousScrollTop) {
            el.scrollTop = nextScrollTop
          }
        })
      }
    },
    [onWheel]
  )

  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        data-slot="popover-content"
        align={align}
        sideOffset={sideOffset}
        className={cn(
          'z-[60] overflow-hidden rounded-md border border-border/50 bg-popover text-popover-foreground shadow-md outline-none data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95',
          className
        )}
        // Why: Electron's -webkit-app-region: drag on the titlebar captures
        // clicks at the OS level regardless of z-index. Without no-drag,
        // popovers that visually overlap the titlebar are unclickable.
        style={
          {
            ...style,
            WebkitAppRegion: 'no-drag'
          } as React.CSSProperties
        }
        onWheel={handleWheel}
        {...props}
      />
    </PopoverPrimitive.Portal>
  )
}

export { Popover, PopoverContent, PopoverTrigger }
