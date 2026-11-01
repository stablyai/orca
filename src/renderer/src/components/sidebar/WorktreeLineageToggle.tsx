import { useId, type MouseEventHandler } from 'react'
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
  'working',
  'monitoring',
  'unconfirmed',
  'interrupted',
  'done',
  'active'
]

export function WorktreeLineageToggle({
  childWorktreeIds = EMPTY_CHILD_IDS,
  collapsed,
  ariaLabel,
  label,
  onToggle
}: {
  childWorktreeIds?: readonly string[]
  collapsed: boolean
  ariaLabel: string
  label: string
  onToggle?: MouseEventHandler<HTMLButtonElement>
}) {
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
    <div className="relative mt-1 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="chip"
            className="relative z-10 max-w-32"
            aria-label={ariaLabel}
            aria-describedby={description ? descriptionId : undefined}
            aria-expanded={!collapsed}
            onClick={onToggle}
          >
            <Workflow className="size-2.5" />
            <span className="truncate">{label}</span>
            <ChevronDown
              className={cn(
                'size-2.5 transition-transform motion-reduce:transition-none',
                collapsed && '-rotate-90'
              )}
            />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="right" sideOffset={8}>
          {collapsed
            ? translate('auto.components.sidebar.WorktreeCard.8cb634cda6', 'Show child workspaces')
            : translate('auto.components.sidebar.WorktreeCard.57eaa61b55', 'Hide child workspaces')}
        </TooltipContent>
      </Tooltip>
      {summary.length > 0 ? (
        <span className="inline-flex flex-wrap items-center gap-x-1.5 gap-y-1 text-3xs leading-none tabular-nums text-muted-foreground">
          {summary.map((status) => (
            <span
              key={status}
              className="inline-flex items-center gap-0.5"
              data-child-worktree-status={status}
            >
              <StatusIndicator status={status} aria-hidden="true" />
              <span aria-hidden="true">{counts.get(status)}</span>
            </span>
          ))}
          <span id={descriptionId} className="sr-only">
            {description}
          </span>
        </span>
      ) : null}
    </div>
  )
}
