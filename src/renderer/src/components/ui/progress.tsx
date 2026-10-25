import * as React from 'react'
import * as ProgressPrimitive from 'radix-ui/progress'

import { cn } from '@/lib/utils'

function Progress({
  className,
  value,
  indeterminate = false,
  paused = false,
  ...props
}: React.ComponentProps<typeof ProgressPrimitive.Root> & {
  indeterminate?: boolean
  paused?: boolean
}) {
  return (
    <ProgressPrimitive.Root
      data-slot="progress"
      value={indeterminate ? null : value}
      className={cn(
        'relative h-2 w-full overflow-hidden rounded-full bg-primary/20',
        indeterminate && 'app-update-progress',
        className
      )}
      data-paused={paused || undefined}
      {...props}
    >
      <ProgressPrimitive.Indicator
        data-slot="progress-indicator"
        className="h-full w-full flex-1 bg-primary transition-all duration-300 ease-out motion-reduce:transition-none"
        style={indeterminate ? undefined : { transform: `translateX(-${100 - (value || 0)}%)` }}
      />
    </ProgressPrimitive.Root>
  )
}

export { Progress }
