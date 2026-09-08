import * as React from 'react'
import { Progress as ProgressPrimitive } from 'radix-ui'

import { cn } from '@/lib/utils'

function Progress({
  className,
  value,
  ...props
}: React.ComponentProps<typeof ProgressPrimitive.Root>) {
  return (
    <ProgressPrimitive.Root
      data-slot="progress"
      value={value}
      className={cn('relative h-2 w-full overflow-hidden rounded-full bg-primary/20', className)}
      {...props}
    >
      <ProgressPrimitive.Indicator
        data-slot="progress-indicator"
        className={cn(
          'h-full w-full flex-1 bg-primary transition-all duration-300 ease-out',
          // Why: an indeterminate bar must still read as indeterminate without motion.
          value === null && 'w-1/3 animate-pulse motion-reduce:animate-none'
        )}
        style={value === null ? undefined : { transform: `translateX(-${100 - (value || 0)}%)` }}
      />
    </ProgressPrimitive.Root>
  )
}

export { Progress }
