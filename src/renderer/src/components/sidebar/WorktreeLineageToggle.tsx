import React, { useId } from 'react'
import { ChevronDown, Workflow } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { getWorktreeStatusLabel, type WorktreeStatus } from '@/lib/worktree-status'
import { cn } from '@/lib/utils'
import StatusIndicator from './StatusIndicator'
import { useWorktreeActivityStatuses } from './use-worktree-activity-statuses'

const EMPTY_CHILD_IDS: readonly string[] = []
const STATUS_ORDER: readonly WorktreeStatus[] = [
  'permission',
  'failed',
  'unconfirmed',
  'working',
  'monitoring',
  'interrupted',
  'done',
  'active'
]

export function WorktreeLineageToggle({
  childWorktreeIds = EMPTY_CHILD_IDS,
  collapsed,
  ariaLabel,
  count,
  newCardStyle,
  onToggle
}: {
  childWorktreeIds?: readonly string[]
  collapsed: boolean
  ariaLabel: string
  count: number
  newCardStyle: boolean
  onToggle?: React.MouseEventHandler<HTMLButtonElement>
}): React.JSX.Element {
  const descriptionId = useId()
  const statuses = useWorktreeActivityStatuses(childWorktreeIds)
  const counts = new Map<WorktreeStatus, number>()
  for (const status of statuses.values()) {
    counts.set(status, (counts.get(status) ?? 0) + 1)
  }
  const summary = STATUS_ORDER.filter((status) => counts.has(status))
  const description = summary
    .map((status) => `${counts.get(status)} ${getWorktreeStatusLabel(status)}`)
    .join(', ')

  return (
    <div
      className={cn(
        '@container relative mt-1 flex min-w-0 justify-start',
        !newCardStyle && '-ml-1'
      )}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="chip"
            className="relative z-10 h-auto min-h-4.5 max-w-full"
            aria-label={ariaLabel}
            aria-describedby={description ? descriptionId : undefined}
            aria-expanded={!collapsed}
            onClick={onToggle}
          >
            <span className="inline-flex min-w-0 flex-wrap items-center gap-1 px-1 py-0.5">
              <span className="inline-flex shrink-0 items-center gap-1">
                <Workflow className="size-2.5 shrink-0" />
                <span className="tabular-nums">{count}</span>
              </span>
              <span className={cn('truncate', summary.length > 0 && 'hidden @min-[13rem]:block')}>
                {count === 1
                  ? translate('auto.components.sidebar.WorktreeList.0c6ee14f23', 'child')
                  : translate('auto.components.sidebar.WorktreeList.045a8aed48', 'children')}
              </span>
              <span className="inline-flex min-w-0 max-w-full items-center gap-0.5">
                {summary.length > 0 ? (
                  <span className="inline-flex min-w-0 flex-wrap items-center gap-1 border-l border-border pl-1">
                    {summary.map((status) => (
                      <span
                        key={status}
                        className="inline-flex shrink-0 items-center gap-0.5 tabular-nums"
                        data-child-worktree-status={status}
                        aria-hidden="true"
                      >
                        {status === 'working' ? (
                          <span className="inline-flex size-3 shrink-0 items-center justify-center">
                            <span className="size-2 rounded-full bg-agent-working" />
                          </span>
                        ) : (
                          <StatusIndicator status={status} showTooltip={false} />
                        )}
                        {counts.get(status)}
                      </span>
                    ))}
                  </span>
                ) : null}
                <ChevronDown
                  className={cn(
                    'size-2.5 shrink-0 transition-transform',
                    collapsed && '-rotate-90'
                  )}
                />
              </span>
            </span>
          </Button>
        </TooltipTrigger>
        <TooltipContent side="right" sideOffset={8}>
          {collapsed
            ? translate(
                'auto.components.sidebar.WorktreeCard.showChildWorktrees',
                'Show children worktrees'
              )
            : translate(
                'auto.components.sidebar.WorktreeCard.hideChildWorktrees',
                'Hide children worktrees'
              )}
          {description ? <div>{description}</div> : null}
        </TooltipContent>
      </Tooltip>
      {description ? (
        <span id={descriptionId} className="sr-only">
          {description}
        </span>
      ) : null}
    </div>
  )
}
