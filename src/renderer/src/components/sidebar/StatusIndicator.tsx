import React from 'react'
import { Hourglass } from 'lucide-react'
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
  // Why: surface the status label as a native tooltip so hovering the dot
  // reveals the state — matters especially for 'active' vs 'done', which
  // share the same emerald dot. Callers pass aria-hidden="true" alongside
  // an sr-only label, so the `title` attribute is ignored by AT and only
  // serves sighted users on hover. Callers can override by passing their
  // own `title`.
  const resolvedTitle = title ?? getWorktreeStatusLabel(status)

  if (status === 'working') {
    return (
      <span
        className={cn('inline-flex h-3 w-3 shrink-0 items-center justify-center', className)}
        title={resolvedTitle}
        {...rest}
      >
        {/* Why: a stepped spin preserves the worker-is-running affordance while
            avoiding a full-refresh-rate compositor loop for long agent runs. */}
        <span className="block size-2 rounded-full border-2 border-yellow-500 border-t-transparent [animation:spin_1s_steps(12,end)_infinite]" />
      </span>
    )
  }

  if (status === 'rate-limited') {
    // Why: a paused/waiting-for-reset agent gets its own amber hourglass so it
    // reads as "Orca is waiting to resume this", distinct from the permission
    // dot (also amber) which demands user action.
    return (
      <span
        className={cn('inline-flex h-3 w-3 shrink-0 items-center justify-center', className)}
        title={resolvedTitle}
        {...rest}
      >
        <Hourglass className="size-2.5 text-amber-500" aria-hidden="true" />
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
            ? 'bg-amber-500'
            : status === 'done' || status === 'active'
              ? // Green dot for both hook-reported 'done' and the heuristic
                // 'active' (terminal open, quiet). Working uses a yellow
                // ring above; 'inactive' stays grey.
                'bg-emerald-500'
              : 'bg-neutral-500/40'
        )}
      />
    </span>
  )
})

export default StatusIndicator
