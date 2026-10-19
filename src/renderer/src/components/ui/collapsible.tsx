'use client'

import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'
import * as CollapsiblePrimitive from 'radix-ui/collapsible'

function Collapsible({
  ...props
}: React.ComponentProps<typeof CollapsiblePrimitive.Root>): React.JSX.Element {
  return <CollapsiblePrimitive.Root data-slot="collapsible" {...props} />
}

const collapsibleTriggerVariants = cva('', {
  variants: {
    variant: {
      default: '',
      row: 'group flex w-full cursor-pointer items-center justify-between gap-4 rounded-md bg-transparent py-2 text-left text-sm font-medium outline-none hover:bg-accent hover:text-accent-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 dark:hover:bg-accent/50',
      transcript:
        'flex min-h-6 w-full items-center gap-1.5 rounded-md py-0.5 text-left text-sm leading-relaxed text-chat-foreground-faint hover:bg-accent/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring'
    }
  },
  defaultVariants: { variant: 'default' }
})

function CollapsibleTrigger({
  className,
  variant,
  ...props
}: React.ComponentProps<typeof CollapsiblePrimitive.Trigger> &
  VariantProps<typeof collapsibleTriggerVariants>): React.JSX.Element {
  return (
    <CollapsiblePrimitive.Trigger
      data-slot="collapsible-trigger"
      className={cn(collapsibleTriggerVariants({ variant }), className)}
      {...props}
    />
  )
}

const collapsibleContentVariants = cva('', {
  variants: {
    animation: {
      none: '',
      // Grows and shrinks with its content, so what follows moves with it instead of jumping.
      height: 'collapsible-height-content'
    }
  },
  defaultVariants: { animation: 'none' }
})

function CollapsibleContent({
  className,
  animation,
  ...props
}: React.ComponentProps<typeof CollapsiblePrimitive.Content> &
  VariantProps<typeof collapsibleContentVariants>): React.JSX.Element {
  return (
    <CollapsiblePrimitive.Content
      data-slot="collapsible-content"
      className={cn(collapsibleContentVariants({ animation }), className)}
      {...props}
    />
  )
}

export { Collapsible, CollapsibleTrigger, CollapsibleContent }
