import { useMemo } from 'react'
import { RefreshCw } from 'lucide-react'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { Card } from '../ui/card'
import { useTranslate } from '@/i18n/use-translate'
import {
  groupIssuesByKanbanColumn,
  WORKBENCH_KANBAN_COLUMNS
} from '../../../../shared/github/issue-flow/issue-kanban'
import { useWorkbenchKanbanIssues } from './use-workbench-kanban-issues'

export function WorkbenchKanbanPanel(): React.JSX.Element {
  const t = useTranslate()
  const { issues, loading, error, reload, hasRepo } = useWorkbenchKanbanIssues()
  const columns = useMemo(() => groupIssuesByKanbanColumn(issues), [issues])

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
                {t(`auto.components.workbench.kanban.${column}`, column)} · {columns[column].length}
              </span>
              {columns[column].map((issue) => (
                <div key={`${issue.url}#${issue.number}`} className="rounded-md border p-2 text-sm">
                  <span className="block truncate">
                    #{issue.number} {issue.title}
                  </span>
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
