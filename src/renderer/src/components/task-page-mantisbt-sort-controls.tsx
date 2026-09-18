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
import type { MantisBTIssueSortColumn, MantisBTIssueSortDirection } from './mantisbt-issue-sorter'

type MantisBTSortColumn = {
  id: MantisBTIssueSortColumn
  label: string
  className?: string
}

type TaskPageMantisBTSortControlsProps = {
  direction: MantisBTIssueSortDirection
  onSort: (column: MantisBTIssueSortColumn) => void
  orderBy: MantisBTIssueSortColumn
}

const MANTISBT_SORT_COLUMN_IDS = [
  'title',
  'status',
  'priority',
  'handler',
  'updated'
] as const satisfies readonly MantisBTIssueSortColumn[]

function isMantisBTIssueSortColumn(value: string): value is MantisBTIssueSortColumn {
  return MANTISBT_SORT_COLUMN_IDS.some((id) => id === value)
}

function getMantisBTSortColumns(): MantisBTSortColumn[] {
  return [
    { id: 'title', label: translate('auto.components.TaskPage.b1eaa18ace', 'Issue') },
    { id: 'status', label: translate('auto.components.TaskPage.154b0fa623', 'Status') },
    { id: 'priority', label: translate('auto.components.TaskPage.c8d5bec5f7', 'Priority') },
    {
      id: 'handler',
      label: translate('auto.components.TaskPage.mantisbtSortHandler', 'Handler'),
      className: 'max-lg:!hidden'
    },
    {
      id: 'updated',
      label: translate('auto.components.TaskPage.f362667d55', 'Updated'),
      className: 'max-lg:!hidden'
    }
  ]
}

export function TaskPageMantisBTSortControls({
  direction,
  onSort,
  orderBy
}: TaskPageMantisBTSortControlsProps): React.JSX.Element {
  const columns = getMantisBTSortColumns()
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
      <div className="grid h-8 flex-none grid-cols-[minmax(0,1fr)_120px_92px_64px] items-center gap-3 border-b border-border/50 bg-muted/25 px-3 text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground max-md:!hidden lg:grid-cols-[minmax(0,1.3fr)_132px_110px_140px_96px_64px]">
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
        data-testid="mantisbt-mobile-sort-controls"
        className="hidden h-10 flex-none items-center gap-2 border-b border-border/50 bg-muted/25 px-3 max-md:!flex"
      >
        <span className="shrink-0 text-[11px] font-semibold tracking-[0.05em] text-muted-foreground uppercase">
          {sortByLabel}
        </span>
        <Select
          value={orderBy}
          onValueChange={(value) => {
            if (isMantisBTIssueSortColumn(value)) {
              onSort(value)
            }
          }}
        >
          <SelectTrigger size="sm" aria-label={sortByLabel} className="min-w-0 flex-1">
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
