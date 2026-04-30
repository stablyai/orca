import React from 'react'
import { CircleCheck } from 'lucide-react'
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
  // Why: surface the status label as a native tooltip so hovering the
  // indicator reveals the state — matters especially for 'active' vs
  // 'done' (dot vs check both in emerald). Callers pass aria-hidden="true"
  // alongside an sr-only label, so the `title` attribute is ignored by AT
  // and only serves sighted users on hover. Callers can override by
  // passing their own `title`.
  const resolvedTitle = title ?? getWorktreeStatusLabel(status)

  if (status === 'working') {
    return (
      <span
        className={cn('inline-flex h-3 w-3 shrink-0 items-center justify-center', className)}
        title={resolvedTitle}
        {...rest}
      >
        <span className="block size-2 rounded-full border-2 border-yellow-500 border-t-transparent animate-spin" />
      </span>
    )
  }

  if (status === 'done') {
    // Why: agent-reported completion gets a check icon instead of a dot so
    // it is visually distinct from 'active' (terminal open, quiet), which
    // also renders emerald. Before this, users with the experimental
    // agent-tracking toggle couldn't tell a newly-opened quiet terminal
    // apart from a completed agent — both were emerald dots.
    return (
      <span
        className={cn('inline-flex h-3 w-3 shrink-0 items-center justify-center', className)}
        title={resolvedTitle}
        {...rest}
      >
        <CircleCheck className="size-3 text-emerald-500" aria-hidden="true" />
      </span>
    )
  }

  return (
    <span
      className={cn('inline-flex h-3 w-3 shrink-0 items-center justify-center', className)}
      title={resolvedTitle}
      {...rest}
    >
      <span
        className={cn(
          'block size-2 rounded-full',
          status === 'permission'
            ? 'bg-red-500'
            : status === 'active'
              ? 'bg-emerald-500'
              : 'bg-neutral-500/40'
        )}
      />
    </span>
  )
})

export default StatusIndicator
