'use client'

import * as React from 'react'
import { Label as LabelPrimitive } from 'radix-ui'

import { cn } from '@/lib/utils'

/** `sm` is the sidebar's field-label treatment, named as `SelectTrigger` names the same density. */
function Label({
  className,
  size = 'default',
  ...props
}: React.ComponentProps<typeof LabelPrimitive.Root> & { size?: 'default' | 'sm' }) {
  return (
    <LabelPrimitive.Root
      data-slot="label"
      data-size={size}
      className={cn(
        'flex items-center gap-2 text-sm leading-none font-medium select-none group-data-[disabled=true]:pointer-events-none group-data-[disabled=true]:opacity-50 peer-disabled:cursor-not-allowed peer-disabled:opacity-50',
        'data-[size=sm]:text-[11px] data-[size=sm]:text-muted-foreground',
        className
      )}
      {...props}
    />
  )
}

export { Label }
