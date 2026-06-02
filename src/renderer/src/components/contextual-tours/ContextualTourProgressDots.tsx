import type { JSX } from 'react'
import { cn } from '@/lib/utils'

export function ContextualTourProgressDots({
  current,
  total
}: {
  current: number
  total: number
}): JSX.Element {
  if (total <= 1) {
    return <span aria-hidden="true" className="h-1.5 w-4" />
  }
  return (
    <div
      className="flex items-center gap-2"
      role="progressbar"
      aria-valuemin={1}
      aria-valuemax={total}
      aria-valuenow={current}
      aria-label={`Step ${current} of ${total}`}
    >
      <span className="flex items-center gap-1.5" aria-hidden="true">
        {Array.from({ length: total }).map((_, index) => {
          const isActive = index + 1 === current
          const isComplete = index + 1 < current
          return (
            <span
              key={index}
              className={cn(
                'block h-1.5 rounded-full transition-all duration-200 ease-out',
                isActive
                  ? 'w-4 bg-foreground'
                  : isComplete
                    ? 'w-1.5 bg-foreground/55'
                    : 'w-1.5 bg-foreground/20'
              )}
            />
          )
        })}
      </span>
      <span className="whitespace-nowrap text-[11px] font-medium leading-none text-muted-foreground">
        {current} of {total}
      </span>
    </div>
  )
}
