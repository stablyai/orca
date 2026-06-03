import React from 'react'

import { cn } from '@/lib/utils'

// Why: mirror Linear's priority glyph shape while keeping color on Orca tokens.
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
          'inline-flex size-4 shrink-0 items-center justify-center rounded-sm bg-destructive text-[10px] font-semibold leading-none text-destructive-foreground',
          className
        )}
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
      className={cn('inline-flex size-4 shrink-0 items-end justify-center gap-px', className)}
      title={label}
    >
      {[1, 2, 3].map((bar) => (
        <span
          key={bar}
          aria-hidden="true"
          className={cn(
            'w-1 rounded-[1px]',
            bar === 1 && 'h-1.5',
            bar === 2 && 'h-2.5',
            bar === 3 && 'h-3.5',
            bar <= activeBars ? 'bg-foreground' : 'bg-muted-foreground/20'
          )}
        />
      ))}
      <span className="sr-only">Priority: {label}</span>
    </span>
  )
}
