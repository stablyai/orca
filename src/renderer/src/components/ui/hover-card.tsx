'use client'

import * as React from 'react'
import * as HoverCardPrimitive from 'radix-ui/hover-card'
import { useControllableState } from 'radix-ui/internal'
import { cva, type VariantProps } from 'class-variance-authority'

import { cn } from '@/lib/class-names'

const HoverCardInteractionContext = React.createContext({
  dismiss: () => {},
  reset: () => {}
})

function HoverCard({
  open: controlledOpen,
  defaultOpen,
  onOpenChange,
  ...props
}: React.ComponentProps<typeof HoverCardPrimitive.Root>) {
  const [open, setOpen] = useControllableState({
    prop: controlledOpen,
    defaultProp: defaultOpen ?? false,
    onChange: onOpenChange,
    caller: 'HoverCard'
  })
  const blocked = React.useRef(false)
  const dismiss = React.useCallback(() => {
    blocked.current = true
    setOpen(false)
  }, [setOpen])
  const reset = React.useCallback(() => {
    blocked.current = false
  }, [])
  const interaction = React.useMemo(() => ({ dismiss, reset }), [dismiss, reset])
  return (
    <HoverCardInteractionContext value={interaction}>
      <HoverCardPrimitive.Root
        data-slot="hover-card"
        {...props}
        open={open}
        onOpenChange={(next) => {
          if (!next || !blocked.current) {
            setOpen(next)
          }
        }}
      />
    </HoverCardInteractionContext>
  )
}

function HoverCardTrigger({
  onPointerDown,
  onPointerLeave,
  onContextMenu,
  onBlur,
  ...props
}: React.ComponentProps<typeof HoverCardPrimitive.Trigger>) {
  const { dismiss, reset } = React.useContext(HoverCardInteractionContext)
  return (
    <HoverCardPrimitive.Trigger
      data-slot="hover-card-trigger"
      {...props}
      onPointerDown={(event) => {
        onPointerDown?.(event)
        dismiss()
      }}
      onContextMenu={(event) => {
        onContextMenu?.(event)
        dismiss()
      }}
      onPointerLeave={(event) => {
        onPointerLeave?.(event)
        reset()
      }}
      onBlur={(event) => {
        onBlur?.(event)
        reset()
      }}
    />
  )
}

const hoverCardContentVariants = cva('', {
  variants: {
    variant: {
      default: 'w-64 p-4',
      'workspace-details':
        'w-[360px] max-w-[calc(100vw-2rem)] max-h-[28rem] overflow-y-auto p-3 text-xs scrollbar-sleek',
      'agent-terminal-peek': 'h-72 w-[480px] max-w-[calc(100vw-2rem)] overflow-hidden p-0'
    }
  },
  defaultVariants: { variant: 'default' }
})

function HoverCardContent({
  className,
  variant,
  align = 'center',
  sideOffset = 4,
  ...props
}: React.ComponentProps<typeof HoverCardPrimitive.Content> &
  VariantProps<typeof hoverCardContentVariants>) {
  return (
    <HoverCardPrimitive.Portal data-slot="hover-card-portal">
      <HoverCardPrimitive.Content
        data-slot="hover-card-content"
        align={align}
        sideOffset={sideOffset}
        // Match dropdown surface/border/shadow tokens so hover cards remain distinct from the dark canvas.
        className={cn(
          'z-50 origin-(--radix-hover-card-content-transform-origin) rounded-md border border-black/14 bg-floating-surface text-popover-foreground shadow-[0_16px_36px_rgba(0,0,0,0.24),inset_0_1px_0_rgba(255,255,255,0.14)] backdrop-blur-2xl outline-hidden dark:border-white/14 dark:shadow-[0_20px_44px_rgba(0,0,0,0.42),inset_0_1px_0_rgba(255,255,255,0.04)] data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in motion-reduce:data-[state=open]:animate-none motion-reduce:data-[state=closed]:animate-none data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95',
          hoverCardContentVariants({ variant }),
          className
        )}
        {...props}
      />
    </HoverCardPrimitive.Portal>
  )
}

export { HoverCard, HoverCardTrigger, HoverCardContent }
