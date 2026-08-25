'use client'

import * as React from 'react'
import { Popover as PopoverPrimitive } from 'radix-ui'

import { cn } from '@/lib/utils'

// React delegates wheel passively, so native defaultPrevented may not reflect synthetic cancellation.
const consumerPreventedWheelEvents = new WeakSet<WheelEvent>()

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
function resolvePopoverScroller(
  target: EventTarget | null,
  content: HTMLElement
): HTMLElement | null {
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

function handlePopoverWheel(event: WheelEvent, content: HTMLDivElement): void {
  if (
    event.defaultPrevented ||
    consumerPreventedWheelEvents.has(event) ||
    !(event.target instanceof Node) ||
    !content.contains(event.target)
  ) {
    return
  }

  // Why two markers: `popover-scroll-content` also imposes a 15rem max-height and its
  // own overflow, while `popover-wheel-scroll` opts into the shim alone.
  if (
    !content.classList.contains('popover-scroll-content') &&
    !content.classList.contains('popover-wheel-scroll')
  ) {
    return
  }

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

  // Why: Radix dialog scroll-lock swallows native wheel scrolling in portaled popovers.
  if (nextScrollTop !== el.scrollTop) {
    event.preventDefault()
    el.scrollTop = nextScrollTop
  }
}

type PopoverContentRef = React.ComponentProps<typeof PopoverPrimitive.Content>['ref']

function attachPopoverContent(
  content: HTMLDivElement,
  portalContainer: HTMLElement | null | undefined,
  forwardedRef: PopoverContentRef | undefined
): () => void {
  // React delegates portal events here first, preserving onWheel-before-shim ordering.
  const wheelTarget = portalContainer ?? content.ownerDocument.body
  const handleWheel = (event: WheelEvent): void => handlePopoverWheel(event, content)
  wheelTarget.addEventListener('wheel', handleWheel, { passive: false })

  const refCleanup = typeof forwardedRef === 'function' ? forwardedRef(content) : undefined
  if (forwardedRef && typeof forwardedRef !== 'function') {
    forwardedRef.current = content
  }

  return () => {
    wheelTarget.removeEventListener('wheel', handleWheel)
    if (typeof refCleanup === 'function') {
      refCleanup()
    } else if (typeof forwardedRef === 'function') {
      forwardedRef(null)
    } else if (forwardedRef) {
      forwardedRef.current = null
    }
  }
}

function PopoverContent({
  className,
  align = 'center',
  sideOffset = 4,
  portalContainer,
  style,
  onWheel,
  onWheelCapture,
  ref: forwardedRef,
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Content> & {
  portalContainer?: HTMLElement | null
}) {
  const handleConsumerWheel = React.useCallback(
    (event: React.WheelEvent<HTMLDivElement>): void => {
      onWheel?.(event)
      if (event.defaultPrevented) {
        consumerPreventedWheelEvents.add(event.nativeEvent)
      }
    },
    [onWheel]
  )
  const handleConsumerWheelCapture = React.useCallback(
    (event: React.WheelEvent<HTMLDivElement>): void => {
      onWheelCapture?.(event)
      if (event.defaultPrevented) {
        consumerPreventedWheelEvents.add(event.nativeEvent)
      }
    },
    [onWheelCapture]
  )

  const setContentRef = React.useCallback(
    (node: HTMLDivElement | null) => {
      if (node) {
        return attachPopoverContent(node, portalContainer, forwardedRef)
      }
      if (typeof forwardedRef === 'function') {
        forwardedRef(null)
      } else if (forwardedRef) {
        forwardedRef.current = null
      }
      return undefined
    },
    [forwardedRef, portalContainer]
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
        onWheel={handleConsumerWheel}
        onWheelCapture={handleConsumerWheelCapture}
        {...props}
      />
    </PopoverPrimitive.Portal>
  )
}

export { Popover, PopoverAnchor, PopoverContent, PopoverTrigger }
