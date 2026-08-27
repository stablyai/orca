import React from 'react'
import { ArrowRight, ExternalLink, Flame } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { getIntlLocale, translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import type { KanbanTaskSummary } from '../../../../../shared/kanban-types'

export type KanbanTaskListProps = {
  tasks: readonly KanbanTaskSummary[]
  selectedTaskId: string | null
  onOpenDetail: (task: KanbanTaskSummary) => void
  onStartWorkspace: (task: KanbanTaskSummary) => void
}

function formatDue(due: string | null): string {
  if (!due) {
    return ''
  }
  const parsed = new Date(due)
  return Number.isNaN(parsed.getTime()) ? due : parsed.toLocaleDateString(getIntlLocale())
}

function formatRepositoryUrl(url: string): string {
  return url.replace(/^https?:\/\//, '').replace(/\/+$/, '')
}

export function KanbanTaskList({
  tasks,
  selectedTaskId,
  onOpenDetail,
  onStartWorkspace
}: KanbanTaskListProps): React.JSX.Element {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex-none border-b border-border/50 px-3 py-2 text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
        <span aria-label={translate('auto.components.kanban.list.name', 'Kanban tasks')}>
          {translate('auto.components.kanban.list.name', 'Kanban tasks')}
        </span>
      </div>
      <div
        role="list"
        aria-label={translate('auto.components.kanban.list.name', 'Kanban tasks')}
        className="min-h-0 flex-1 overflow-y-auto scrollbar-sleek divide-y divide-border/50"
        style={{ scrollbarGutter: 'stable' }}
      >
        {tasks.map((task) => {
          const active = selectedTaskId === task.id
          return (
            <div
              role="listitem"
              tabIndex={0}
              key={task.id}
              onClick={() => onOpenDetail(task)}
              onKeyDown={(event) => {
                if (event.target !== event.currentTarget) {
                  return
                }
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  onOpenDetail(task)
                }
              }}
              aria-label={translate(
                'auto.components.kanban.list.rowLabel',
                'Kanban task {{value0}}',
                {
                  value0: task.id
                }
              )}
              className={cn(
                'grid w-full cursor-pointer gap-3 px-3 py-2 text-left grid-cols-[64px_minmax(0,3fr)_100px_80px_28px_minmax(0,1fr)_auto] items-center hover:bg-muted/50',
                active && 'bg-muted/50'
              )}
            >
              <span className="font-mono text-xs text-muted-foreground">{task.id}</span>
              <span className="min-w-0 truncate text-sm">{task.title}</span>
              <span className="truncate text-xs text-muted-foreground">{task.laneName}</span>
              <span className="text-xs text-muted-foreground">{formatDue(task.due)}</span>
              <span className="flex justify-center">
                {task.urgent ? (
                  <span
                    aria-label={translate('auto.components.kanban.list.urgent', 'Urgent')}
                    className="flex h-5 w-5 items-center justify-center"
                  >
                    <Flame className="size-3.5 text-destructive" />
                  </span>
                ) : null}
              </span>
              <span className="truncate font-mono text-[11px] text-muted-foreground">
                {task.repositoryUrls[0] ? formatRepositoryUrl(task.repositoryUrls[0]) : ''}
              </span>
              <div className="flex items-center justify-end gap-1">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      onClick={(event) => {
                        event.stopPropagation()
                        onStartWorkspace(task)
                      }}
                      aria-label={translate(
                        'auto.components.kanban.list.start',
                        'Start workspace from Kanban task {{value0}}',
                        { value0: task.id }
                      )}
                    >
                      <ArrowRight className="size-3.5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" sideOffset={6}>
                    {translate('auto.components.kanban.list.startTooltip', 'Start')}
                  </TooltipContent>
                </Tooltip>
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation()
                    void window.api.shell.openUrl(task.url)
                  }}
                  aria-label={translate(
                    'auto.components.kanban.list.openBrowser',
                    'Open Kanban task {{value0}} in browser',
                    { value0: task.id }
                  )}
                  className="rounded-md p-1 text-muted-foreground transition hover:text-foreground"
                >
                  <ExternalLink className="size-3.5" />
                </button>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
