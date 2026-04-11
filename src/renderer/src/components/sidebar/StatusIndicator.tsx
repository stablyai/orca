import React from 'react'
import { cn } from '@/lib/utils'
import type { WorktreeStatus } from '@/lib/worktree-status'

type StatusIndicatorProps = React.ComponentProps<'span'> & {
  status: WorktreeStatus
}

const StatusIndicator = React.memo(function StatusIndicator({
  status,
  className,
  ...props
}: StatusIndicatorProps) {
  if (status === 'working') {
    return (
      <span
        className={cn('inline-flex h-3 w-3 shrink-0 items-center justify-center', className)}
        {...props}
      >
        <span className="block size-2 rounded-full border-2 border-emerald-500 border-t-transparent animate-spin" />
      </span>
    )
  }

  return (
    <span
      className={cn('inline-flex h-3 w-3 shrink-0 items-center justify-center', className)}
      {...props}
    >
      <span
        className={cn(
          'block size-2 rounded-full',
          status === 'active'
            ? 'bg-emerald-500'
            : status === 'permission'
              ? 'bg-red-500'
              : 'bg-neutral-500/40'
        )}
      />
    </span>
  )
})

export default StatusIndicator
export type { WorktreeStatus as Status }
