import React from 'react'
import { Activity } from 'lucide-react'
import { cn } from '@/lib/utils'
import { AgentQuestionIcon } from '@/components/AgentQuestionIcon'
import { AgentWorkingSpinner } from '@/components/AgentWorkingSpinner'
import {
  StateIndicatorTooltip,
  type StateIndicatorTooltipSide
} from '@/components/StateIndicatorTooltip'
import { getWorktreeStatusLabel, type WorktreeStatus } from '@/lib/worktree-status'

// Why: re-export WorktreeStatus under the existing `Status` alias so the
// sidebar component and the canonical lib share one source of truth — the
// previous local union could silently drift if one side added a new state
// (e.g., 'error') and the other didn't.
export type Status = WorktreeStatus

type StatusIndicatorProps = Omit<React.ComponentProps<'span'>, 'title'> & {
  status: Status
  showTooltip?: boolean
  tooltipSide?: StateIndicatorTooltipSide
}

const AGENT_STATUS_TOOLTIP_STATUSES = new Set<Status>([
  'working',
  'monitoring',
  'permission',
  'interrupted',
  'done'
])

const StatusIndicator = React.memo(function StatusIndicator({
  status,
  className,
  showTooltip = true,
  tooltipSide,
  ...rest
}: StatusIndicatorProps) {
  const tooltipLabel =
    showTooltip && AGENT_STATUS_TOOLTIP_STATUSES.has(status) ? getWorktreeStatusLabel(status) : null
  let indicator: React.JSX.Element

  if (status === 'working') {
    indicator = (
      <span
        className={cn('inline-flex h-3 w-3 shrink-0 items-center justify-center', className)}
        {...rest}
      >
        <AgentWorkingSpinner className="size-2" />
      </span>
    )
  } else if (status === 'monitoring') {
    indicator = (
      <span
        className={cn('inline-flex h-3 w-3 shrink-0 items-center justify-center', className)}
        {...rest}
      >
        <Activity className="size-3 text-yellow-500" aria-hidden="true" />
      </span>
    )
  } else if (status === 'interrupted') {
    indicator = (
      <span
        className={cn('inline-flex h-3 w-3 shrink-0 items-center justify-center', className)}
        {...rest}
      >
        <span className="block size-1.5 rounded-full bg-red-500" />
      </span>
    )
  } else if (status === 'permission') {
    indicator = (
      <span
        className={cn('inline-flex h-3 w-3 shrink-0 items-center justify-center', className)}
        {...rest}
      >
        <AgentQuestionIcon className="size-3" />
      </span>
    )
  } else {
    indicator = (
      <span
        className={cn('inline-flex h-3 w-3 shrink-0 items-center justify-center', className)}
        {...rest}
      >
        <span
          className={cn(
            'block size-2 rounded-full',
            status === 'done' || status === 'active'
              ? // Green dot for both hook-reported 'done' and the heuristic
                // 'active' (terminal open, quiet). Working uses a yellow
                // ring above; 'inactive' stays grey.
                'bg-emerald-500'
              : 'bg-neutral-500/40'
          )}
        />
      </span>
    )
  }

  return (
    <StateIndicatorTooltip label={tooltipLabel} side={tooltipSide}>
      {indicator}
    </StateIndicatorTooltip>
  )
})

export default StatusIndicator
