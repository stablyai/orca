'use client'

import * as React from 'react'
import * as LabelPrimitive from 'radix-ui/label'
import { cva, type VariantProps } from 'class-variance-authority'

import { cn } from '@/lib/class-names'

const labelVariants = cva('', {
  variants: {
    variant: {
      default: '',
      settings: 'text-xs text-muted-foreground',
      // Unified dialogs: a field label, a checkbox choice, and a quiet opt-out like "Don’t ask again".
      'dialog-field': 'text-[13px]',
      dialog: 'text-[13px] leading-snug font-normal',
      'dialog-muted': 'text-[13px] leading-snug font-normal text-muted-foreground'
    }
  },
  defaultVariants: { variant: 'default' }
})

function Label({
  className,
  variant,
  ...props
}: React.ComponentProps<typeof LabelPrimitive.Root> & VariantProps<typeof labelVariants>) {
  return (
    <LabelPrimitive.Root
      data-slot="label"
      className={cn(
        'flex items-center gap-2 text-sm leading-none font-medium select-none group-data-[disabled=true]:pointer-events-none group-data-[disabled=true]:opacity-50 peer-disabled:cursor-not-allowed peer-disabled:opacity-50',
        labelVariants({ variant }),
        className
      )}
      {...props}
    />
  )
}

export { Label }
