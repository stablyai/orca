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
      row: 'group flex w-full cursor-pointer items-center justify-between gap-4 rounded-md bg-transparent py-2 text-left text-sm font-medium outline-none hover:bg-accent hover:text-accent-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 dark:hover:bg-accent/50'
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

function CollapsibleContent({
  ...props
}: React.ComponentProps<typeof CollapsiblePrimitive.Content>): React.JSX.Element {
  return <CollapsiblePrimitive.Content data-slot="collapsible-content" {...props} />
}

export { Collapsible, CollapsibleTrigger, CollapsibleContent }
