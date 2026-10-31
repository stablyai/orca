import React from 'react'
import { Activity } from 'lucide-react'
import { cn } from '@/lib/utils'
import { AgentQuestionIcon } from '@/components/AgentQuestionIcon'
import { AgentStateDot } from '@/components/AgentStateDot'
import { AgentWorkingSpinner } from '@/components/AgentWorkingSpinner'
import {
  StateIndicatorTooltip,
  type StateIndicatorTooltipSide
} from '@/components/StateIndicatorTooltip'
import { getWorktreeStatusLabel, type WorktreeStatus } from '@/lib/worktree-status'

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
  'failed',
  'interrupted',
  'unconfirmed',
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
  let glyph: React.JSX.Element

  if (status === 'working') {
    glyph = <AgentWorkingSpinner className="size-2" />
  } else if (status === 'monitoring') {
    glyph = <Activity className="size-3 text-agent-working" aria-hidden="true" />
  } else if (status === 'failed') {
    glyph = <span className="block size-1.5 rounded-full bg-destructive" />
  } else if (status === 'interrupted') {
    // User-requested Stop is neutral rather than failure or completion.
    glyph = <span className="block size-1.5 rounded-full bg-muted-foreground" />
  } else if (status === 'unconfirmed') {
    // Reuse the missing-evidence glyph/tone without nesting its tooltip.
    glyph = <AgentStateDot state="unconfirmed" size="md" title={null} />
  } else if (status === 'permission') {
    glyph = <AgentQuestionIcon className="size-3" />
  } else {
    glyph = (
      <span
        className={cn(
          'block size-2 rounded-full',
          status === 'done' || status === 'active'
            ? // Quiet active terminals share the completed-session dot.
              'bg-emerald-500'
            : 'bg-neutral-500/40'
        )}
      />
    )
  }

  // Why one wrapper: a sidebar backdrop reads each card's status from this attribute.
  const indicator = (
    <span
      className={cn('inline-flex h-3 w-3 shrink-0 items-center justify-center', className)}
      data-worktree-status={status}
      {...rest}
    >
      {glyph}
    </span>
  )

  return (
    <StateIndicatorTooltip label={tooltipLabel} side={tooltipSide}>
      {indicator}
    </StateIndicatorTooltip>
  )
})

export default StatusIndicator
