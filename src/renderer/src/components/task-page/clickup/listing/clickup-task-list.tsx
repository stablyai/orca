import React from 'react'
import { ArrowRight, CalendarDays, ExternalLink } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { formatUiRelativeTimeFromDate } from '@/i18n/relative-time-format'
import { useIntlLocale, useTranslate } from '@/i18n/use-translate'
import { openAppHttpLink } from '@/lib/browser/navigation/app-http-link-open'
import { cn } from '@/lib/class-names'
import type { ClickUpTask } from '../../../../../../shared/clickup/clickup-types'
import {
  ClickUpAssignees,
  ClickUpPriorityLabel,
  ClickUpStatusPill
} from './clickup-task-presentation'

export function formatClickUpDueDate(dueAt: string, intlLocale: string | undefined): string | null {
  const date = new Date(dueAt)
  return Number.isNaN(date.getTime())
    ? null
    : new Intl.DateTimeFormat(intlLocale, { month: 'short', day: 'numeric' }).format(date)
}

export function clickUpTaskLocation(task: ClickUpTask): string {
  return [task.folder?.name, task.list.name].filter(Boolean).join(' / ')
}

function ClickUpTaskRow({
  task,
  selected,
  onOpenTask,
  onStartWorkspace
}: {
  task: ClickUpTask
  selected: boolean
  onOpenTask: (task: ClickUpTask) => void
  onStartWorkspace: (task: ClickUpTask) => void
}): React.JSX.Element {
  const t = useTranslate()
  const intlLocale = useIntlLocale()
  const identifier = task.customId ?? task.id
  const dueLabel = task.dueAt ? formatClickUpDueDate(task.dueAt, intlLocale) : null
  const tags = task.tags.slice(0, 2)
  return (
    // Why: the row contains action buttons, so a native button wrapper would create invalid nested buttons; role + keyboard handling preserves access.
    <div
      role="button"
      tabIndex={0}
      aria-current={selected ? 'true' : undefined}
      data-current={selected ? 'true' : undefined}
      onClick={() => onOpenTask(task)}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) {
          return
        }
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onOpenTask(task)
        }
      }}
      className={cn(
        'group/row flex min-h-12 cursor-pointer items-center gap-3 px-3 py-2 text-left transition hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
        selected && 'bg-accent'
      )}
    >
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{identifier}</span>
          <h3 className="min-w-0 truncate text-[13px] font-medium text-foreground">{task.name}</h3>
        </div>
        <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <ClickUpStatusPill status={task.status} className="max-w-[180px]" />
          <ClickUpPriorityLabel priority={task.priority} />
          <span className="min-w-0 max-w-[260px] truncate text-[11px] text-muted-foreground">
            {clickUpTaskLocation(task)}
          </span>
          {tags.map((tag) => (
            <span
              key={tag}
              className="max-w-[140px] truncate rounded-full border border-border/50 bg-muted/35 px-1.5 py-0.5 text-[10px] text-muted-foreground"
            >
              {tag}
            </span>
          ))}
          {task.tags.length > tags.length ? (
            <span className="text-[10px] text-muted-foreground">
              +{task.tags.length - tags.length}
            </span>
          ) : null}
        </div>
      </div>
      {dueLabel ? (
        <span className="hidden shrink-0 items-center gap-1 text-[11px] text-muted-foreground @2xl:inline-flex">
          <CalendarDays aria-hidden className="size-3" />
          {dueLabel}
        </span>
      ) : null}
      <span className="hidden w-20 shrink-0 text-right text-[11px] text-muted-foreground @3xl:block">
        {formatUiRelativeTimeFromDate(task.updatedAt, undefined, intlLocale)}
      </span>
      <ClickUpAssignees assignees={task.assignees} />
      <div className="flex shrink-0 items-center justify-end gap-1">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={(event) => {
                event.stopPropagation()
                onStartWorkspace(task)
              }}
              aria-label={t(
                'auto.components.TaskPage.ff90d0abc7',
                'Start workspace from {{value0}}',
                { value0: identifier }
              )}
            >
              <ArrowRight className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={6}>
            {t('auto.components.TaskPage.9497f2787c', 'Start workspace')}
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={(event) => {
                event.stopPropagation()
                openAppHttpLink(task.url, { event })
              }}
              aria-label={t('taskProviders.clickup.openTaskAria', 'Open {{value0}} in ClickUp', {
                value0: identifier
              })}
            >
              <ExternalLink className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={6}>
            {t('taskProviders.clickup.openInClickUp', 'Open in ClickUp')}
          </TooltipContent>
        </Tooltip>
      </div>
    </div>
  )
}

export function ClickUpTaskList({
  tasks,
  selectedTaskId,
  onOpenTask,
  onStartWorkspace
}: {
  tasks: readonly ClickUpTask[]
  selectedTaskId: string | null
  onOpenTask: (task: ClickUpTask) => void
  onStartWorkspace: (task: ClickUpTask) => void
}): React.JSX.Element {
  return (
    <div className="divide-y divide-border/50">
      {tasks.map((task) => (
        <ClickUpTaskRow
          key={task.id}
          task={task}
          selected={task.id === selectedTaskId}
          onOpenTask={onOpenTask}
          onStartWorkspace={onStartWorkspace}
        />
      ))}
    </div>
  )
}
