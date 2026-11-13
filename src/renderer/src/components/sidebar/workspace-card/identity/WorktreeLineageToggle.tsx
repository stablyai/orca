import { useId, type MouseEventHandler } from 'react'
import { ChevronDown, Workflow } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'
import { getWorktreeStatusLabel } from '@/lib/workspace/activity/worktree-status'
import type { WorktreeStatus } from '../../../../../../shared/worktree-status-rollup'
import { cn } from '@/lib/class-names'
import StatusIndicator from '../surface/StatusIndicator'
import { useWorktreeActivityStatuses } from '../activity/use-worktree-activity-statuses'

const EMPTY_CHILD_IDS: readonly string[] = []
// Agent states only: 'active' (a tab is open) shares Done's dot and would read as a second Done.
const STATUS_ORDER: readonly WorktreeStatus[] = [
  'permission',
  'failed',
  'working',
  'monitoring',
  'unconfirmed',
  'interrupted',
  'done'
]

export function WorktreeLineageToggle({
  childWorktreeIds = EMPTY_CHILD_IDS,
  hiddenUnreadCount = 0,
  collapsed,
  ariaLabel,
  label,
  count,
  onToggle
}: {
  childWorktreeIds?: readonly string[]
  /** Unread workspaces hidden under this collapsed lineage, grandchildren included. */
  hiddenUnreadCount?: number
  collapsed: boolean
  ariaLabel: string
  label: string
  count: number
  onToggle?: MouseEventHandler<HTMLButtonElement>
}) {
  const t = useTranslate()
  const descriptionId = useId()
  const statuses = useWorktreeActivityStatuses(childWorktreeIds)
  const counts = new Map<WorktreeStatus, number>()
  for (const status of statuses.values()) {
    counts.set(status, (counts.get(status) ?? 0) + 1)
  }
  const summary = STATUS_ORDER.filter((status) => counts.has(status))
  // Expanded children show their own unread dots.
  const unreadCount = collapsed ? hiddenUnreadCount : 0
  const description = [
    summary.map((status) => `${counts.get(status)} ${getWorktreeStatusLabel(status)}`).join(', '),
    unreadCount > 0
      ? t('workspace.activity.hiddenUnread', '{{count}} unread', {
          count: unreadCount,
          defaultValue_one: '{{count}} unread'
        })
      : ''
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <div className="@container relative mt-1 flex min-w-0 justify-start">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="chip"
            className="relative z-10 h-auto min-h-4 max-w-full"
            aria-label={ariaLabel}
            aria-describedby={description ? descriptionId : undefined}
            aria-expanded={!collapsed}
            onClick={onToggle}
          >
            <span className="inline-flex min-w-0 max-w-full flex-wrap items-center gap-x-1 gap-y-0.5 py-0.5">
              <span className="inline-flex shrink-0 items-center gap-1">
                <span className="relative inline-flex shrink-0">
                  <Workflow className="size-2.5" />
                  {unreadCount > 0 ? (
                    <span
                      data-lineage-hidden-unread=""
                      className="pointer-events-none absolute -right-0.5 -top-0.5 size-1.5 rounded-full bg-worktree-unread ring-1 ring-background"
                      aria-hidden="true"
                    />
                  ) : null}
                </span>
                <span
                  className={cn('tabular-nums', summary.length > 0 && 'hidden @min-[13rem]:inline')}
                >
                  {label}
                </span>
                {summary.length > 0 ? (
                  <span className="tabular-nums @min-[13rem]:hidden">{count}</span>
                ) : null}
              </span>
              <span className="inline-flex min-w-0 max-w-full items-center gap-0.5">
                {summary.length > 0 ? (
                  <span className="inline-flex min-w-0 flex-wrap items-center gap-0.5 border-l border-border pl-1 text-muted-foreground @max-[13rem]:pl-0.5">
                    {summary.map((status) => (
                      <span
                        key={status}
                        className="inline-flex shrink-0 items-center gap-0.5 tabular-nums @max-[13rem]:gap-0"
                        data-child-worktree-status={status}
                        aria-hidden="true"
                      >
                        <StatusIndicator status={status} showTooltip={false} />
                        <span>{counts.get(status)}</span>
                      </span>
                    ))}
                  </span>
                ) : null}
                <ChevronDown
                  className={cn(
                    'size-2.5 shrink-0 transition-transform motion-reduce:transition-none',
                    collapsed && '-rotate-90'
                  )}
                />
              </span>
            </span>
          </Button>
        </TooltipTrigger>
        <TooltipContent side="right" sideOffset={8}>
          {collapsed
            ? t('auto.components.sidebar.WorktreeCard.8cb634cda6', 'Show child workspaces')
            : t('auto.components.sidebar.WorktreeCard.57eaa61b55', 'Hide child workspaces')}
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
