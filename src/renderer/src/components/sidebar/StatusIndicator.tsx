import React from 'react'
import { cn } from '@/lib/utils'
import type { WorktreeStatus } from '@/lib/worktree-status'

// Why: re-export WorktreeStatus under the existing `Status` alias so the
// sidebar component and the canonical lib share one source of truth — the
// previous local union could silently drift if one side added a new state
// (e.g., 'error') and the other didn't.
export type Status = WorktreeStatus

type StatusIndicatorProps = React.ComponentProps<'span'> & {
  status: Status
}

const StatusIndicator = React.memo(function StatusIndicator({
  status,
  className,
  ...rest
}: StatusIndicatorProps) {
  if (status === 'working') {
    return (
      <span
        className={cn('inline-flex h-3 w-3 shrink-0 items-center justify-center', className)}
        {...rest}
      >
        <span className="block size-2 rounded-full border-2 border-emerald-500 border-t-transparent animate-spin" />
      </span>
    )
  }

  return (
    <span
      className={cn('inline-flex h-3 w-3 shrink-0 items-center justify-center', className)}
      {...rest}
    >
      <span
        className={cn(
          'block size-2 rounded-full',
          status === 'permission'
            ? 'bg-red-500'
            : status === 'done'
              ? // Green dot for done so working (green spinner) and done (green
                // solid) share a hue; motion is the differentiator. 'active'
                // (terminal open, quiet) collapses to the same grey as
                // 'inactive' to free the green for the done state.
                'bg-emerald-500'
              : 'bg-neutral-500/40'
        )}
      />
    </span>
  )
})

export default StatusIndicator
