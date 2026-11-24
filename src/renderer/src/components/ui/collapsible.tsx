'use client'

import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/class-names'
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
      chat: 'group flex max-w-full items-start gap-1 rounded-md py-0.5 text-left text-sm text-chat-foreground-faint hover:text-chat-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
      row: 'group flex w-full cursor-pointer items-center justify-between gap-4 rounded-md bg-transparent py-2 text-left text-sm font-medium outline-none hover:bg-accent hover:text-accent-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 dark:hover:bg-accent/50',
      // A one-line summary of settings inside a bordered box, opening to edit them.
      summary:
        'group flex w-full cursor-pointer items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-left text-sm text-muted-foreground outline-none hover:bg-accent/50 focus-visible:ring-[3px] focus-visible:ring-ring/50'
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
      fade: 'data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:duration-150 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:duration-150 motion-reduce:data-[state=open]:animate-none motion-reduce:data-[state=closed]:animate-none',
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
