import { ArrowRight, ExternalLink } from 'lucide-react'
import type { ClickUpTask } from '../../../shared/clickup-types'
import { Button } from '@/components/ui/button'
import { getIntlLocale, translate } from '@/i18n/i18n'
import { clickUpTaskReference } from './clickup-task-page-model'

const TASK_GRID_COLUMNS = 'grid-cols-[110px_minmax(0,2fr)_140px_140px_110px_64px]'

export function ClickUpTaskListTable({
  tasks,
  loading,
  error,
  onOpenTask,
  onStartWorkspace
}: {
  tasks: readonly ClickUpTask[]
  loading: boolean
  error: string | null
  onOpenTask: (task: ClickUpTask) => void
  onStartWorkspace: (task: ClickUpTask) => void
}): React.JSX.Element {
  return (
    <>
      <div
        className={`grid ${TASK_GRID_COLUMNS} gap-3 border-b border-border bg-muted/35 px-3 py-2 text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground`}
      >
        <span>{translate('auto.components.clickup.page.id', 'ID')}</span>
        <span>{translate('auto.components.clickup.page.name', 'Name')}</span>
        <span>{translate('auto.components.clickup.page.status', 'Status')}</span>
        <span>{translate('auto.components.clickup.page.list', 'List')}</span>
        <span>{translate('auto.components.clickup.page.updated', 'Updated')}</span>
        <span />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-sleek">
        {loading && tasks.length === 0 ? (
          <div className="divide-y divide-border">
            {Array.from({ length: 8 }).map((_, index) => (
              <div key={index} className={`grid ${TASK_GRID_COLUMNS} gap-3 px-3 py-3`}>
                {Array.from({ length: 5 }).map((__, cell) => (
                  <div key={cell} className="h-3 animate-pulse rounded bg-muted" />
                ))}
              </div>
            ))}
          </div>
        ) : null}
        {!loading && tasks.length === 0 && !error ? (
          <div className="px-4 py-12 text-center">
            <p className="text-sm font-medium text-foreground">
              {translate('auto.components.clickup.page.emptyTitle', 'No ClickUp tasks found')}
            </p>
            <p className="mt-2 text-sm text-muted-foreground">
              {translate(
                'auto.components.clickup.page.emptyDescription',
                'Try another filter or search term.'
              )}
            </p>
          </div>
        ) : null}
        <div className="divide-y divide-border">
          {tasks.map((task) => (
            <div
              key={`${task.workspaceId}:${task.id}`}
              role="button"
              tabIndex={0}
              onClick={() => onOpenTask(task)}
              onKeyDown={(event) => {
                if (
                  event.target === event.currentTarget &&
                  (event.key === 'Enter' || event.key === ' ')
                ) {
                  event.preventDefault()
                  onOpenTask(task)
                }
              }}
              className={`grid ${TASK_GRID_COLUMNS} cursor-pointer gap-3 px-3 py-2 text-left hover:bg-accent`}
            >
              <span className="truncate font-mono text-xs text-muted-foreground">
                {clickUpTaskReference(task)}
              </span>
              <span className="truncate text-sm text-foreground">{task.name}</span>
              <span className="truncate text-xs text-muted-foreground">{task.status.name}</span>
              <span className="truncate text-xs text-muted-foreground">{task.list.name}</span>
              <span className="text-xs text-muted-foreground">
                {new Date(task.updatedAt).toLocaleDateString(getIntlLocale())}
              </span>
              <div className="flex items-center justify-end gap-1">
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={(event) => {
                    event.stopPropagation()
                    onStartWorkspace(task)
                  }}
                >
                  <ArrowRight />
                  <span className="sr-only">
                    {translate('auto.components.clickup.page.startWorkspace', 'Start workspace')}
                  </span>
                </Button>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={(event) => {
                    event.stopPropagation()
                    void window.api.shell.openUrl(task.url)
                  }}
                >
                  <ExternalLink />
                  <span className="sr-only">
                    {translate('auto.components.clickup.page.openTask', 'Open in ClickUp')}
                  </span>
                </Button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </>
  )
}
