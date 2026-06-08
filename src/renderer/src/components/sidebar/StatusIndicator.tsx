import React from 'react'
import { cn } from '@/lib/utils'
import { getWorktreeStatusLabel, type WorktreeStatus } from '@/lib/worktree-status'

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
  title,
  ...rest
}: StatusIndicatorProps) {
  // Why: color is reserved for state that needs the user (STYLEGUIDE.md). Only
  // `working` (quiet spinner) and `permission` get a dot; `done` is left to the
  // unread bell, which already signals completion and clears on view.
  const dot =
    status === 'working' ? (
      <span className="block size-2 rounded-full border-2 border-muted-foreground border-t-transparent animate-spin" />
    ) : status === 'permission' ? (
      <span className="block size-2 rounded-full bg-status-warning" />
    ) : null

  // Why: keep the 3×3 lane even when there's no dot so titles stay aligned
  // across rows; only attach the hover tooltip when a dot is actually visible.
  return (
    <span
      className={cn('inline-flex h-3 w-3 shrink-0 items-center justify-center', className)}
      title={dot ? (title ?? getWorktreeStatusLabel(status)) : undefined}
      {...rest}
    >
      {dot}
    </span>
  )
})

export default StatusIndicator
