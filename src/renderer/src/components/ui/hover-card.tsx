'use client'

import * as React from 'react'
import { HoverCard as HoverCardPrimitive } from 'radix-ui'

import { cn } from '@/lib/utils'

// Why: the stuck-card guard in HoverCardContent must tell its own trigger apart
// from every other hover card on screen, so each root shares one trigger ref.
const HoverCardTriggerRef = React.createContext<React.RefObject<HTMLElement | null> | null>(null)

function setRef<T>(ref: React.Ref<T> | undefined, value: T | null): void {
  if (typeof ref === 'function') {
    ref(value)
  } else if (ref) {
    ;(ref as React.RefObject<T | null>).current = value
  }
}

function HoverCard({ ...props }: React.ComponentProps<typeof HoverCardPrimitive.Root>) {
  const triggerRef = React.useRef<HTMLElement | null>(null)
  return (
    <HoverCardTriggerRef.Provider value={triggerRef}>
      <HoverCardPrimitive.Root data-slot="hover-card" {...props} />
    </HoverCardTriggerRef.Provider>
  )
}

function HoverCardTrigger({
  ref,
  ...props
}: React.ComponentProps<typeof HoverCardPrimitive.Trigger>) {
  const triggerRef = React.useContext(HoverCardTriggerRef)
  const composedRef = React.useCallback(
    (node: HTMLAnchorElement | null) => {
      setRef(ref, node)
      if (triggerRef) {
        triggerRef.current = node
      }
    },
    [ref, triggerRef]
  )
  return <HoverCardPrimitive.Trigger data-slot="hover-card-trigger" ref={composedRef} {...props} />
}

function HoverCardContent({
  className,
  align = 'center',
  sideOffset = 4,
  ref,
  onPointerLeave,
  ...props
}: React.ComponentProps<typeof HoverCardPrimitive.Content>) {
  const triggerRef = React.useContext(HoverCardTriggerRef)
  const [contentNode, setContentNode] = React.useState<HTMLDivElement | null>(null)
  const composedRef = React.useCallback(
    (node: HTMLDivElement | null) => {
      setRef(ref, node)
      setContentNode(node)
    },
    [ref]
  )
  // The pointer may sit in the trigger→content gap before it ever reaches the
  // card, so only arm the guard once the card itself has really been hovered.
  const enteredRef = React.useRef(false)

  // Why: Radix reschedules the close only from the content's own pointerleave.
  // Moving between sidebar rows can cancel the close timer via the content's
  // pointerenter and then never deliver the matching pointerleave, leaving the
  // card stuck open indefinitely (#10254). Track the real pointer position and
  // replay the pointerout Radix is waiting for once the pointer is provably off
  // both the card and its trigger.
  React.useEffect(() => {
    if (!contentNode) {
      enteredRef.current = false
      return
    }
    const handlePointerMove = (event: PointerEvent): void => {
      if (event.pointerType === 'touch') {
        return
      }
      const target = event.target as Node | null
      if (target && contentNode.contains(target)) {
        enteredRef.current = true
        return
      }
      if (!enteredRef.current) {
        return
      }
      // Returning to this card's own trigger keeps it open by design.
      if (target && triggerRef?.current?.contains(target)) {
        return
      }
      enteredRef.current = false
      contentNode.dispatchEvent(
        new PointerEvent('pointerout', {
          bubbles: true,
          relatedTarget: target as EventTarget | null,
          pointerType: event.pointerType
        })
      )
    }
    document.addEventListener('pointermove', handlePointerMove)
    return () => {
      document.removeEventListener('pointermove', handlePointerMove)
    }
  }, [contentNode, triggerRef])

  return (
    <HoverCardPrimitive.Portal data-slot="hover-card-portal">
      <HoverCardPrimitive.Content
        data-slot="hover-card-content"
        align={align}
        sideOffset={sideOffset}
        ref={composedRef}
        onPointerLeave={(event) => {
          enteredRef.current = false
          onPointerLeave?.(event)
        }}
        // Why: matches the dropdown-menu recipe — translucent surface, solid
        // 14% border, dual shadow, and 2xl backdrop blur. The previous
        // border-border/50 + bg-popover made the hover card blend into the
        // dark canvas (#171717 vs #0a0a0a, ~3% white lift) with a near-
        // invisible border.
        className={cn(
          'z-50 w-64 origin-(--radix-hover-card-content-transform-origin) rounded-md border border-black/14 bg-[rgba(255,255,255,0.82)] p-4 text-popover-foreground shadow-[0_16px_36px_rgba(0,0,0,0.24),inset_0_1px_0_rgba(255,255,255,0.14)] backdrop-blur-2xl outline-hidden dark:border-white/14 dark:bg-[rgba(0,0,0,0.72)] dark:shadow-[0_20px_44px_rgba(0,0,0,0.42),inset_0_1px_0_rgba(255,255,255,0.04)] data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95',
          className
        )}
        {...props}
      />
    </HoverCardPrimitive.Portal>
  )
}

export { HoverCard, HoverCardTrigger, HoverCardContent }
