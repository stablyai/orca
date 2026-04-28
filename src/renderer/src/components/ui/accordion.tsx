'use client'

import * as React from 'react'
import { ChevronDown } from 'lucide-react'
import { Accordion as AccordionPrimitive } from 'radix-ui'

import { cn } from '@/lib/utils'

function Accordion({
  className,
  ...props
}: React.ComponentProps<typeof AccordionPrimitive.Root>): React.JSX.Element {
  return <AccordionPrimitive.Root data-slot="accordion" className={cn(className)} {...props} />
}

function AccordionItem({
  className,
  ...props
}: React.ComponentProps<typeof AccordionPrimitive.Item>): React.JSX.Element {
  return (
    <AccordionPrimitive.Item
      data-slot="accordion-item"
      className={cn('border-b last:border-b-0', className)}
      {...props}
    />
  )
}

function AccordionTrigger({
  className,
  children,
  ...props
}: React.ComponentProps<typeof AccordionPrimitive.Trigger>): React.JSX.Element {
  return (
    <AccordionPrimitive.Header className="flex">
      <AccordionPrimitive.Trigger
        data-slot="accordion-trigger"
        className={cn(
          'flex flex-1 items-center justify-between gap-2 py-2 text-left text-sm font-medium outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 [&[data-state=open]>svg]:rotate-180',
          className
        )}
        {...props}
      >
        {children}
        <ChevronDown className="size-4 shrink-0 text-muted-foreground transition-transform duration-200" />
      </AccordionPrimitive.Trigger>
    </AccordionPrimitive.Header>
  )
}

function AccordionContent({
  className,
  children,
  ...props
}: React.ComponentProps<typeof AccordionPrimitive.Content>): React.JSX.Element {
  return (
    <AccordionPrimitive.Content
      data-slot="accordion-content"
      className="overflow-hidden"
      {...props}
    >
      <div className={cn('pb-2 pt-0', className)}>{children}</div>
    </AccordionPrimitive.Content>
  )
}

export { Accordion, AccordionItem, AccordionTrigger, AccordionContent }
