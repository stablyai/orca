import { useMemo } from 'react'
import { Play, RefreshCw } from 'lucide-react'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { Card } from '../ui/card'
import { useTranslate } from '@/i18n/use-translate'
import {
  groupIssuesByKanbanColumn,
  WORKBENCH_KANBAN_COLUMNS,
  type WorkbenchKanbanColumnId
} from '../../../../shared/github/issue-flow/issue-kanban'
import type { IssueInfo } from '../../../../shared/github/pull-requests/pull-request-types'
import { useWorkbenchKanbanIssues } from './use-workbench-kanban-issues'

export function WorkbenchKanbanPanel({
  onStartIssue
}: {
  onStartIssue?: (issue: IssueInfo) => void
}): React.JSX.Element {
  const t = useTranslate()
  const { issues, loading, error, reload, hasRepo } = useWorkbenchKanbanIssues()
  const columns = useMemo(() => groupIssuesByKanbanColumn(issues), [issues])
  // Static keys so extraction and catalogs see every column; the template form hid them.
  const columnLabels: Record<WorkbenchKanbanColumnId, string> = {
    todo: t('auto.components.workbench.kanban.todo', 'Todo'),
    doing: t('auto.components.workbench.kanban.doing', 'Doing'),
    review: t('auto.components.workbench.kanban.review', 'Review'),
    done: t('auto.components.workbench.kanban.done', 'Done')
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex items-center justify-end">
        <Button variant="ghost" size="xs" onClick={() => void reload()} disabled={loading}>
          <RefreshCw className="size-4" />
          {t('auto.components.workbench.kanban.reload', 'Reload')}
        </Button>
      </div>
      {!hasRepo ? (
        <Card className="p-3 text-sm text-muted-foreground">
          {t(
            'auto.components.workbench.kanban.noRepo',
            'Open a workspace repository to see its GitHub issues here.'
          )}
        </Card>
      ) : error ? (
        <Card className="p-3 text-sm text-muted-foreground">{error}</Card>
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-2 gap-2 overflow-y-auto xl:grid-cols-4 scrollbar-sleek">
          {WORKBENCH_KANBAN_COLUMNS.map((column) => (
            <Card key={column} className="flex min-h-0 flex-col gap-2 p-2">
              <span className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
                {columnLabels[column]} · {columns[column].length}
              </span>
              {columns[column].map((issue) => (
                <div key={`${issue.url}#${issue.number}`} className="rounded-md border p-2 text-sm">
                  <div className="flex items-start justify-between gap-1.5">
                    <span className="min-w-0 truncate">
                      #{issue.number} {issue.title}
                    </span>
                    {onStartIssue ? (
                      <Button
                        variant="ghost"
                        size="xs"
                        className="shrink-0"
                        onClick={() => onStartIssue(issue)}
                      >
                        <Play className="size-3" />
                        {t('auto.components.workbench.kanban.start', 'Start')}
                      </Button>
                    ) : null}
                  </div>
                  {issue.labels.length > 0 ? (
                    <span className="mt-1 flex flex-wrap gap-1">
                      {issue.labels.slice(0, 3).map((label) => (
                        <Badge key={label} variant="secondary" className="rounded-full">
                          {label}
                        </Badge>
                      ))}
                    </span>
                  ) : null}
                </div>
              ))}
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
