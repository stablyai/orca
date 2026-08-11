import { ArrowDown, ArrowUp } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import type { JiraIssueSortColumn, JiraIssueSortDirection } from './jira-issue-sorter'

type JiraSortColumn = {
  id: JiraIssueSortColumn
  label: string
  className?: string
}

type TaskPageJiraSortControlsProps = {
  direction: JiraIssueSortDirection
  onSort: (column: JiraIssueSortColumn) => void
  orderBy: JiraIssueSortColumn
}

function getJiraSortColumns(): JiraSortColumn[] {
  return [
    { id: 'key', label: translate('auto.components.TaskPage.37e7ee311e', 'Key') },
    { id: 'title', label: translate('auto.components.TaskPage.b1eaa18ace', 'Issue') },
    { id: 'status', label: translate('auto.components.TaskPage.154b0fa623', 'Status') },
    { id: 'priority', label: translate('auto.components.TaskPage.c8d5bec5f7', 'Priority') },
    {
      id: 'assignee',
      label: translate('auto.components.TaskPage.d2a876ca53', 'Assignee'),
      className: 'max-lg:!hidden'
    },
    { id: 'updated', label: translate('auto.components.TaskPage.f362667d55', 'Updated') }
  ]
}

export function TaskPageJiraSortControls({
  direction,
  onSort,
  orderBy
}: TaskPageJiraSortControlsProps): React.JSX.Element {
  const columns = getJiraSortColumns()
  const directionLabel =
    direction === 'asc'
      ? translate('auto.components.TaskPage.jiraSortAscending', 'ascending')
      : translate('auto.components.TaskPage.jiraSortDescending', 'descending')
  const nextDirectionLabel =
    direction === 'asc'
      ? translate('auto.components.TaskPage.jiraSortDescending', 'descending')
      : translate('auto.components.TaskPage.jiraSortAscending', 'ascending')
  const sortByLabel = translate('auto.components.TaskPage.jiraSortBy', 'Sort by')
  const toggleDirectionLabel = translate(
    'auto.components.TaskPage.jiraToggleSortDirection',
    'Sort {{value0}}',
    { value0: nextDirectionLabel }
  )

  return (
    <>
      <div className="grid h-8 flex-none grid-cols-[90px_minmax(0,1fr)_128px_92px_80px_64px] items-center gap-3 border-b border-border/50 bg-muted/25 px-3 text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground max-md:!hidden lg:grid-cols-[96px_minmax(0,1.25fr)_132px_120px_136px_96px_64px] xl:grid-cols-[104px_minmax(0,1.45fr)_144px_132px_160px_128px_72px]">
        {columns.map((column) => (
          <button
            key={column.id}
            type="button"
            onClick={() => onSort(column.id)}
            aria-label={orderBy === column.id ? `${column.label}, ${directionLabel}` : column.label}
            aria-pressed={orderBy === column.id}
            className={cn(
              'flex items-center gap-1 rounded-sm text-left text-[11px] font-semibold tracking-[0.08em] uppercase select-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none',
              column.className
            )}
          >
            {column.label}
            {orderBy === column.id &&
              (direction === 'asc' ? (
                <ArrowUp aria-hidden="true" className="size-3" />
              ) : (
                <ArrowDown aria-hidden="true" className="size-3" />
              ))}
          </button>
        ))}
        <span />
      </div>

      <div
        data-testid="jira-mobile-sort-controls"
        className="hidden h-10 flex-none items-center gap-2 border-b border-border/50 bg-muted/25 px-3 max-md:!flex"
      >
        <span className="shrink-0 text-[11px] font-semibold tracking-[0.05em] text-muted-foreground uppercase">
          {sortByLabel}
        </span>
        <Select value={orderBy} onValueChange={(value) => onSort(value as JiraIssueSortColumn)}>
          <SelectTrigger
            size="sm"
            aria-label={sortByLabel}
            className="min-w-0 flex-1 border-border/50 bg-background text-xs shadow-none"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {columns.map((column) => (
              <SelectItem key={column.id} value={column.id}>
                {column.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={toggleDirectionLabel}
              onClick={() => onSort(orderBy)}
            >
              {direction === 'asc' ? (
                <ArrowUp aria-hidden="true" className="size-3.5" />
              ) : (
                <ArrowDown aria-hidden="true" className="size-3.5" />
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={6}>
            {toggleDirectionLabel}
          </TooltipContent>
        </Tooltip>
      </div>
    </>
  )
}
