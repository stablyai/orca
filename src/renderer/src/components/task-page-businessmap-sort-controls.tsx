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
import type {
  BusinessmapCardSortColumn,
  BusinessmapCardSortDirection
} from './task-page-businessmap-card-sort'

type BusinessmapSortColumn = {
  id: BusinessmapCardSortColumn
  label: string
  className?: string
}

type TaskPageBusinessmapSortControlsProps = {
  direction: BusinessmapCardSortDirection
  onSort: (column: BusinessmapCardSortColumn) => void
  orderBy: BusinessmapCardSortColumn
}

function getBusinessmapSortColumns(): BusinessmapSortColumn[] {
  return [
    { id: 'updated', label: translate('auto.components.TaskPage.jiraSortUpdated', 'Updated') },
    { id: 'column', label: translate('auto.components.TaskPage.businessmapSortColumn', 'Column') },
    { id: 'title', label: translate('auto.components.TaskPage.jiraSortTitle', 'Title') },
    {
      id: 'assignee',
      label: translate('auto.components.TaskPage.jiraSortAssignee', 'Assignee')
    },
    { id: 'id', label: translate('auto.components.TaskPage.jiraSortKey', 'ID') }
  ]
}

export function TaskPageBusinessmapSortControls({
  direction,
  onSort,
  orderBy
}: TaskPageBusinessmapSortControlsProps): React.JSX.Element {
  const columns = getBusinessmapSortColumns()
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
      <div className="grid h-8 flex-none grid-cols-[72px_minmax(0,1fr)_132px_120px_96px_64px] items-center gap-3 border-b border-border/50 bg-muted/25 px-3 text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground max-md:!hidden">
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
        data-testid="businessmap-mobile-sort-controls"
        className="hidden h-10 flex-none items-center gap-2 border-b border-border/50 bg-muted/25 px-3 max-md:!flex"
      >
        <span className="shrink-0 text-[11px] font-semibold tracking-[0.05em] text-muted-foreground uppercase">
          {sortByLabel}
        </span>
        <Select
          value={orderBy}
          onValueChange={(value: string) => {
            const column = columns.find((candidate) => candidate.id === value)
            if (column) {
              onSort(column.id)
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
