import * as React from 'react'
import * as ProgressPrimitive from 'radix-ui/progress'

import { cn } from '@/lib/utils'

function Progress({
  className,
  value,
  tone = 'default',
  ...props
}: React.ComponentProps<typeof ProgressPrimitive.Root> & {
  /** 'warning' when the bar means a limit is reached (e.g. all sandbox hours used). */
  tone?: 'default' | 'warning'
}) {
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
          'h-full w-full flex-1 transition-all duration-300 ease-out motion-reduce:transition-none',
          tone === 'warning' ? 'bg-status-warning' : 'bg-primary'
        )}
        style={{ transform: `translateX(-${100 - (value || 0)}%)` }}
      />
    </ProgressPrimitive.Root>
  )
}

export { Progress }
