import React from 'react'
import { MoreVertical } from 'lucide-react'
import { AgentStateDot } from '@/components/AgentStateDot'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { RepoBadgeMark } from '@/components/repo/RepoBadgeLabel'
import type { Repo } from '../../../../shared/repo-types'
import {
  formatAbsoluteDate,
  formatRelativeTime,
  threadAgentState,
  threadAgentStateLabel
} from './activity-thread-presentation'
import type { ActivityThreadGroup, AgentPaneThread } from './activity-thread-types'

export function EventTime({ timestamp }: { timestamp: number }): React.JSX.Element {
  const absolute = formatAbsoluteDate(timestamp)
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className="rounded px-1 py-0.5 text-xs text-muted-foreground hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
          aria-label={absolute}
          onClick={(event) => event.stopPropagation()}
        >
          {formatRelativeTime(timestamp)}
        </button>
      </TooltipTrigger>
      <TooltipContent side="right" sideOffset={6}>
        {absolute}
      </TooltipContent>
    </Tooltip>
  )
}

export function ActivityThreadOptionsMenu({
  compactMode,
  hasUnreadThreads,
  onCompactModeChange,
  onMarkAllThreadsRead
}: {
  compactMode: boolean
  hasUnreadThreads: boolean
  onCompactModeChange: (compactMode: boolean) => void
  onMarkAllThreadsRead: () => void
}): React.JSX.Element {
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          {/* Why: keep Tooltip and Dropdown from composing refs onto the same button (Radix setRef crash loop). */}
          <span className="inline-flex shrink-0">
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="size-8 shrink-0 border-input bg-transparent p-0 text-muted-foreground shadow-xs hover:bg-accent hover:text-accent-foreground dark:bg-transparent dark:hover:bg-accent dark:hover:text-accent-foreground"
                aria-label={translate(
                  'auto.components.activity.ActivityPrototypePage.db8a1878b5',
                  'Thread list options'
                )}
              >
                <MoreVertical className="size-3.5" />
              </Button>
            </DropdownMenuTrigger>
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          {translate('auto.components.activity.ActivityPrototypePage.a472a14700', 'More options')}
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" sideOffset={6}>
        <DropdownMenuCheckboxItem
          checked={compactMode}
          onCheckedChange={(checked) => onCompactModeChange(checked === true)}
          onSelect={(event) => event.preventDefault()}
        >
          {translate('auto.components.activity.ActivityPrototypePage.f70e4bec47', 'Compact mode')}
        </DropdownMenuCheckboxItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onMarkAllThreadsRead} disabled={!hasUnreadThreads}>
          {translate('auto.components.activity.ActivityPrototypePage.023ff75afe', 'Mark all read')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
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
  group
}: {
  group: ActivityThreadGroup
}): React.JSX.Element {
  return (
    <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-border bg-background/95 px-3 py-1.5 backdrop-blur supports-[backdrop-filter]:bg-background/80">
      {group.state ? (
        <span className="inline-flex size-4 shrink-0 items-center justify-center">
          <AgentStateDot state={group.state} size="sm" />
        </span>
      ) : null}
      <span className="min-w-0 flex-1 truncate text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
        {group.label}
      </span>
      <span className="rounded-full border border-border bg-accent px-1.5 py-0.5 text-[10px] font-semibold leading-none text-muted-foreground">
        {group.threads.length}
      </span>
    </div>
  )
}
