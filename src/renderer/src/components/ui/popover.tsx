'use client'

import * as React from 'react'
import { Popover as PopoverPrimitive } from 'radix-ui'

import { cn } from '@/lib/utils'
import { updatePopoverContentRef } from './popover-content-ref'

function Popover(props: React.ComponentProps<typeof PopoverPrimitive.Root>) {
  return <PopoverPrimitive.Root data-slot="popover" {...props} />
}

function PopoverTrigger(props: React.ComponentProps<typeof PopoverPrimitive.Trigger>) {
  return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />
}

function PopoverAnchor(props: React.ComponentProps<typeof PopoverPrimitive.Anchor>) {
  return <PopoverPrimitive.Anchor data-slot="popover-anchor" {...props} />
}

/**
 * Nearest scrollable element between the wheel target and the popover content,
 * inclusive of both. Returns null when nothing in that chain can scroll.
 */
function resolvePopoverScroller(target: EventTarget | null, content: HTMLElement): HTMLElement | null {
  let node = target instanceof Node ? target : null
  while (node && node !== content.parentNode) {
    if (node instanceof HTMLElement && node.scrollHeight > node.clientHeight) {
      const overflowY = getComputedStyle(node).overflowY
      if (overflowY === 'auto' || overflowY === 'scroll') {
        return node
      }
    }
    node = node.parentNode
  }
  return null
}

function PopoverContent({
  className,
  align = 'center',
  sideOffset = 4,
  portalContainer,
  style,
  onWheel,
  ref: forwardedRef,
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Content> & {
  portalContainer?: HTMLElement | null
}) {
  const wheelFrameIdsRef = React.useRef<Set<number>>(new Set())

  const cancelWheelFrames = React.useCallback(() => {
    for (const frameId of wheelFrameIdsRef.current) {
      cancelAnimationFrame(frameId)
    }
    wheelFrameIdsRef.current.clear()
  }, [])

  const setContentRef = React.useCallback(
    (node: HTMLDivElement | null) => {
      // Why: the wheel shim schedules frames against the content node; cancel
      // them when Radix removes that node instead of from a passive Effect.
      return updatePopoverContentRef(forwardedRef, node, cancelWheelFrames)
    },
    [cancelWheelFrames, forwardedRef]
  )

  const handleWheel = React.useCallback(
    (event: React.WheelEvent<HTMLDivElement>) => {
      onWheel?.(event)
      if (event.defaultPrevented) {
        return
      }

      const content = event.currentTarget
      // Why two markers: `popover-scroll-content` also imposes a 15rem max-height and its
      // own overflow, which a popover that manages its own layout (a fixed-height flex
      // column over a pinned footer) must not inherit. `popover-wheel-scroll` opts into
      // the shim alone.
      if (
        !content.classList.contains('popover-scroll-content') &&
        !content.classList.contains('popover-wheel-scroll')
      ) {
        return
      }

      // Why resolve rather than use currentTarget: a popover whose content is a flex
      // column with a nested viewport (a ScrollArea above a pinned footer) is itself
      // overflow-hidden, so the scroller is a descendant under the pointer.
      const el = resolvePopoverScroller(event.target, content)
      if (!el) {
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
        const frameId = requestAnimationFrame(() => {
          wheelFrameIdsRef.current.delete(frameId)
          if (el.scrollTop === previousScrollTop) {
            el.scrollTop = nextScrollTop
          }
        })
        wheelFrameIdsRef.current.add(frameId)
      }
    },
    [onWheel]
  )

  return (
    <PopoverPrimitive.Portal container={portalContainer ?? undefined}>
      <PopoverPrimitive.Content
        data-slot="popover-content"
        align={align}
        sideOffset={sideOffset}
        // Why: matches the dropdown-menu recipe — translucent surface, solid
        // 14% border, dual shadow, and 2xl backdrop blur. bg-popover equals
        // the canvas in dark mode (#171717 vs #0a0a0a) and border-border/50
        // is too faint to read, so the popover blended into the background.
        className={cn(
          'z-[60] overflow-hidden rounded-md border border-black/14 bg-[rgba(255,255,255,0.82)] text-popover-foreground shadow-[0_16px_36px_rgba(0,0,0,0.24),inset_0_1px_0_rgba(255,255,255,0.14)] backdrop-blur-2xl outline-none dark:border-white/14 dark:bg-[rgba(0,0,0,0.72)] dark:shadow-[0_20px_44px_rgba(0,0,0,0.42),inset_0_1px_0_rgba(255,255,255,0.04)] data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95',
          className
        )}
        ref={setContentRef}
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

export { Popover, PopoverAnchor, PopoverContent, PopoverTrigger }
