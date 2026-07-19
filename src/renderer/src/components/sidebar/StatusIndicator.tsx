import React from 'react'
import { cn } from '@/lib/utils'
import { getWorktreeStatusLabel, type WorktreeStatus } from '@/lib/worktree-status'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

// Why: re-export WorktreeStatus under the existing `Status` alias so the
// sidebar component and the canonical lib share one source of truth — the
// previous local union could silently drift if one side added a new state
// (e.g., 'error') and the other didn't.
export type Status = WorktreeStatus

type StatusIndicatorProps = Omit<React.ComponentProps<'span'>, 'title'> & {
  status: Status
  showTooltip?: boolean
  tooltipSide?: React.ComponentProps<typeof TooltipContent>['side']
  tooltipSideOffset?: number
  tooltipLabel?: React.ReactNode
}

const StatusIndicator = React.memo(function StatusIndicator({
  status,
  className,
  showTooltip = true,
  tooltipSide = 'top',
  tooltipSideOffset = 4,
  tooltipLabel,
  'aria-label': ariaLabel,
  'aria-hidden': ariaHidden,
  ...rest
}: StatusIndicatorProps) {
  const label = getWorktreeStatusLabel(status)
  const hiddenFromAssistiveTech = ariaHidden === true || ariaHidden === 'true'

  const indicator =
    status === 'working' ? (
      <span
        className={cn('inline-flex h-3 w-3 shrink-0 items-center justify-center', className)}
        role={hiddenFromAssistiveTech ? undefined : 'img'}
        aria-label={hiddenFromAssistiveTech ? undefined : (ariaLabel ?? label)}
        aria-hidden={ariaHidden}
        {...rest}
      >
        {/* Why: a stepped spin preserves the worker-is-running affordance while
            avoiding a full-refresh-rate compositor loop for long agent runs. */}
        <span className="block size-2 rounded-full border-2 border-status-working border-t-transparent [animation:spin_1s_steps(12,end)_infinite] motion-reduce:animate-none" />
      </span>
    ) : (
      <span
        className={cn('inline-flex h-3 w-3 shrink-0 items-center justify-center', className)}
        role={hiddenFromAssistiveTech ? undefined : 'img'}
        aria-label={hiddenFromAssistiveTech ? undefined : (ariaLabel ?? label)}
        aria-hidden={ariaHidden}
        {...rest}
      >
        <span
          className={cn(
            'block size-2 rounded-full',
            status === 'blocked' || status === 'interrupted'
              ? 'bg-destructive'
              : status === 'permission'
                ? 'bg-status-attention'
                : status === 'done' || status === 'active'
                  ? // Green dot for both hook-reported 'done' and the heuristic
                    // 'active' (terminal open, quiet). Working uses a yellow
                    // ring above; 'inactive' stays grey.
                    'bg-status-success'
                  : 'bg-muted-foreground'
          )}
        />
      </span>
    )

  if (!showTooltip) {
    return indicator
  }

  // Why: active and done intentionally share a glyph; the documented Tooltip
  // primitive makes their exact meaning discoverable without a native title.
  return (
    <Tooltip>
      <TooltipTrigger asChild>{indicator}</TooltipTrigger>
      <TooltipContent side={tooltipSide} sideOffset={tooltipSideOffset}>
        {tooltipLabel ?? label}
      </TooltipContent>
    </Tooltip>
  )
})

export default StatusIndicator
