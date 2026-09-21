import React from 'react'
import { ChevronDown } from 'lucide-react'
import { AgentStateDot } from '@/components/AgentStateDot'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { useNow } from '@/hooks/use-now'
import { cn } from '@/lib/utils'
import { formatShortTimeAgo } from '@/lib/short-time-ago'
import { RepoBadgeMark } from '@/components/repo/RepoBadgeLabel'
import type { Repo } from '../../../../shared/repo-types'
import {
  formatAbsoluteDate,
  formatRelativeTime,
  threadAgentState,
  threadAgentStateLabel
} from './activity-thread-presentation'
import type { ActivityThreadGroup, AgentPaneThread } from './activity-thread-types'

export { ActivityThreadOptionsMenu } from './activity-thread-options-menu'

export function EventTime({
  timestamp,
  compact = false
}: {
  timestamp: number
  compact?: boolean
}): React.JSX.Element {
  // Why: rows reuse their identity across store writes, so this label can't rely on
  // incidental re-renders to stay honest; the shared visibility-gated clock re-renders
  // only this leaf (memo'd rows stay bailed out). 30s cadence matches WorktreeCardAgents.
  const now = useNow(30_000)
  const absolute = formatAbsoluteDate(timestamp)
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className={cn(
            'rounded text-muted-foreground hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none',
            compact ? 'px-0 py-0 text-[11px] tabular-nums' : 'px-1 py-0.5 text-xs'
          )}
          aria-label={absolute}
          onClick={(event) => event.stopPropagation()}
        >
          {compact ? formatShortTimeAgo(timestamp, now) : formatRelativeTime(timestamp, now)}
        </button>
      </TooltipTrigger>
      <TooltipContent side="right" sideOffset={6}>
        {absolute}
      </TooltipContent>
    </Tooltip>
  )
}

export function ActivityProjectLabel({ repo }: { repo: Repo | null }): React.JSX.Element {
  const label =
    repo?.displayName?.trim() ||
    translate('auto.components.activity.ActivityPrototypePage.5651b216c6', 'Unknown project')
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      {repo ? <RepoBadgeMark color={repo.badgeColor} /> : null}
      <span
        className="min-w-0 truncate text-[11px] font-semibold uppercase tracking-[0.04em] text-muted-foreground"
        title={label}
      >
        {label}
      </span>
    </div>
  )
}

export function EventRepoBadge({ repo }: { repo: Repo | null }): React.JSX.Element | null {
  if (!repo) {
    return null
  }
  return (
    <div className="flex min-w-0 shrink-0 items-center gap-1.5 rounded-[4px] border border-border bg-accent px-1.5 py-0.5 dark:border-border/60 dark:bg-accent/50">
      <RepoBadgeMark color={repo.badgeColor} />
      <span className="max-w-[6rem] truncate text-[10px] font-semibold leading-none text-foreground lowercase">
        {repo.displayName}
      </span>
    </div>
  )
}

export function ThreadAgentStateIndicator({
  thread
}: {
  thread: AgentPaneThread
}): React.JSX.Element {
  const state = threadAgentState(thread)
  const label = threadAgentStateLabel(thread)
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex size-4 shrink-0 items-center justify-center">
          <AgentStateDot state={state} size="md" title={null} />
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        {label}
      </TooltipContent>
    </Tooltip>
  )
}

export function ActivityStatusGroupHeader({
  group,
  collapsed = false,
  onToggle,
  className
}: {
  group: ActivityThreadGroup
  collapsed?: boolean
  onToggle?: () => void
  className?: string
}): React.JSX.Element {
  const isInteractive = Boolean(onToggle)
  return (
    <div
      role={isInteractive ? 'button' : undefined}
      tabIndex={isInteractive ? 0 : undefined}
      aria-expanded={isInteractive ? !collapsed : undefined}
      onClick={onToggle}
      onKeyDown={
        isInteractive
          ? (event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                onToggle?.()
              }
            }
          : undefined
      }
      className={cn(
        'group flex h-7 select-none items-center gap-1.5 rounded-md px-1.5 py-1 text-muted-foreground transition-colors',
        isInteractive && 'cursor-pointer hover:bg-accent/60 hover:text-foreground',
        className
      )}
    >
      <ChevronDown
        className={cn(
          'size-3 shrink-0 text-muted-foreground transition-transform duration-150 group-hover:text-foreground',
          collapsed && '-rotate-90'
        )}
      />
      {group.state ? (
        <span className="inline-flex size-4 shrink-0 items-center justify-center">
          <AgentStateDot state={group.state} size="sm" />
        </span>
      ) : null}
      <span className="min-w-0 flex-1 truncate text-[11px] font-semibold uppercase tracking-[0.05em] text-foreground/80 transition-colors group-hover:text-foreground">
        {group.label}
      </span>
      <span className="rounded-full border border-border/80 bg-muted/80 px-1.5 py-0.5 text-[10px] font-semibold tabular-nums leading-none text-foreground/80 shadow-xs">
        {group.threads.length}
      </span>
    </div>
  )
}
