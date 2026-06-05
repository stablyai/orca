import React from 'react'

import { cn } from '@/lib/utils'

// Why: Linear priority glyphs are provider-brand signals, so their fills match
// Linear's lower-contrast icon colors instead of Orca's generic state tokens.
const LINEAR_PRIORITY_URGENT_FILL = 'lch(66 80 48)'
const LINEAR_PRIORITY_BAR_FILL = 'lch(39.576 1.25 282)'

const LINEAR_PRIORITY_ICON_LABELS: Record<number, string> = {
  0: 'No priority',
  1: 'Urgent',
  2: 'High',
  3: 'Medium',
  4: 'Low'
}

function getLinearPriorityBarCount(priority: number): number {
  if (priority === 2) {
    return 3
  }
  if (priority === 3) {
    return 2
  }
  if (priority === 4) {
    return 1
  }
  return 0
}

export function getLinearPriorityIconLabel(priority: number): string {
  return LINEAR_PRIORITY_ICON_LABELS[priority] ?? `P${priority}`
}

export function LinearPriorityIcon({
  priority,
  className,
  label = getLinearPriorityIconLabel(priority)
}: {
  priority: number
  className?: string
  label?: string
}): React.JSX.Element {
  if (priority === 1) {
    return (
      <span
        className={cn(
          'inline-flex size-4 shrink-0 items-center justify-center rounded-sm text-[10px] font-semibold leading-none text-white',
          className
        )}
        style={{ backgroundColor: LINEAR_PRIORITY_URGENT_FILL }}
        title={label}
      >
        <span aria-hidden="true">!</span>
        <span className="sr-only">Priority: {label}</span>
      </span>
    )
  }

  if (priority === 0) {
    return (
      <span
        className={cn('inline-flex size-4 shrink-0 items-center justify-center', className)}
        title={label}
      >
        <span
          aria-hidden="true"
          className="size-3 rounded-full border border-muted-foreground/55"
        />
        <span className="sr-only">Priority: {label}</span>
      </span>
    )
  }

  const activeBars = getLinearPriorityBarCount(priority)
  return (
    <span
      className={cn(
        'linear-priority-bars inline-flex size-4 shrink-0 items-center justify-center',
        className
      )}
      title={label}
    >
      <svg aria-hidden="true" className="size-full" viewBox="0 0 16 16" fill="none">
        {[1, 2, 3].map((bar) => {
          const height = bar === 1 ? 5 : bar === 2 ? 8 : 11
          const x = bar === 1 ? 2.25 : bar === 2 ? 6.5 : 10.75
          return (
            <rect
              key={bar}
              x={x}
              y={16 - height}
              width="3.25"
              height={height}
              rx="1"
              fill={
                bar <= activeBars
                  ? LINEAR_PRIORITY_BAR_FILL
                  : 'var(--linear-priority-bar-inactive-fill)'
              }
            />
          )
        })}
      </svg>
      <span className="sr-only">Priority: {label}</span>
    </span>
  )
}
