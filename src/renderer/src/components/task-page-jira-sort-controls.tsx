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
import {
  getJiraListColumnLabel,
  jiraListColumnVisibility,
  type JiraListColumn
} from './jira-list-columns'
import type { JiraIssueSortColumn, JiraIssueSortDirection } from './jira-issue-sorter'

type TaskPageJiraSortControlsProps = {
  columns: readonly JiraListColumn[]
  direction: JiraIssueSortDirection
  onSort: (column: JiraIssueSortColumn) => void
  orderBy: JiraIssueSortColumn
}

export function TaskPageJiraSortControls({
  columns: visibleColumns,
  direction,
  onSort,
  orderBy
}: TaskPageJiraSortControlsProps): React.JSX.Element {
  const columns = visibleColumns.map((column) => ({
    id: column.id,
    label: getJiraListColumnLabel(column.id)
  }))
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
      <div className="sticky top-0 z-10 grid h-8 flex-none grid-cols-(--jira-cols-md) @3xl:min-w-(--jira-min-md) items-center gap-3 border-b border-border/50 bg-background px-3 text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground @max-3xl:!hidden @5xl:grid-cols-(--jira-cols-lg) @5xl:min-w-(--jira-min-lg) @7xl:grid-cols-(--jira-cols-xl) @7xl:min-w-(--jira-min-xl)">
        {columns.map((column) => (
          <button
            key={column.id}
            type="button"
            onClick={() => onSort(column.id)}
            aria-label={orderBy === column.id ? `${column.label}, ${directionLabel}` : column.label}
            aria-pressed={orderBy === column.id}
            className={cn(
              'flex items-center gap-1 rounded-sm text-left text-[11px] font-semibold tracking-[0.08em] uppercase select-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none',
              (column.id === 'storyPoints' ||
                column.id === 'originalEstimate' ||
                column.id === 'remainingEstimate') &&
                'justify-end text-right',
              jiraListColumnVisibility(column.id)
            )}
          >
            <span className="truncate">{column.label}</span>
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
        className="hidden h-10 flex-none items-center gap-2 border-b border-border/50 bg-background px-3 @max-3xl:!flex"
      >
        <span className="shrink-0 text-[11px] font-semibold tracking-[0.05em] text-muted-foreground uppercase">
          {sortByLabel}
        </span>
        <Select
          value={orderBy}
          onValueChange={(value) => {
            const column = visibleColumns.find((candidate) => candidate.id === value)
            if (column) {
              onSort(column.id)
            }
          }}
        >
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
