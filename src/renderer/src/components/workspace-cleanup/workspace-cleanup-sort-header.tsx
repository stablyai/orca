import React from 'react'
import { ArrowDown, ArrowUp, Check, ChevronsUpDown, Minus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { translate } from '@/i18n/i18n'
import { WORKSPACE_CLEANUP_SORT_FIELD_VALUES } from '../../../../shared/workspace-cleanup-facet-rankings'
import type {
  WorkspaceCleanupSortField,
  WorkspaceCleanupSortState
} from '../../../../shared/workspace-cleanup-filter-model'
import { getWorkspaceCleanupSortFieldLabel } from './workspace-cleanup-facet-labels'

export function WorkspaceCleanupSortHeader({
  sort,
  selectableCount,
  selectedCount,
  onToggleSortField,
  onToggleSelectAll
}: {
  sort: WorkspaceCleanupSortState
  selectableCount: number
  selectedCount: number
  onToggleSortField: (field: WorkspaceCleanupSortField) => void
  onToggleSelectAll: (selectAll: boolean) => void
}): React.JSX.Element {
  const allSelected = selectableCount > 0 && selectedCount >= selectableCount
  const someSelected = selectableCount > 0 && selectedCount > 0 && !allSelected
  const selectAllLabel =
    selectableCount === 1
      ? translate(
          'components.workspace.cleanup.browse.selectAllCountOne',
          'Select 1 safety-checked workspace'
        )
      : translate(
          'components.workspace.cleanup.browse.selectAllCount',
          'Select all {{value0}} safety-checked workspaces',
          { value0: selectableCount }
        )
  return (
    <div className="flex items-center gap-1 border-b border-border bg-muted/25 px-3 py-1.5">
      <button
        type="button"
        role="checkbox"
        aria-checked={someSelected ? 'mixed' : allSelected}
        disabled={selectableCount === 0}
        aria-label={selectAllLabel}
        onClick={() => onToggleSelectAll(!allSelected)}
        className="flex size-4 shrink-0 items-center justify-center rounded border border-border bg-background text-primary hover:bg-accent disabled:opacity-40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        {allSelected ? (
          <Check className="size-3" strokeWidth={3} />
        ) : someSelected ? (
          <Minus className="size-3" strokeWidth={3} />
        ) : null}
      </button>
      <span className="min-w-0 flex-1 text-xs text-muted-foreground">{selectAllLabel}</span>
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="xs"
            className="shrink-0 text-[11px] text-muted-foreground"
            aria-label={translate(
              'components.workspace.cleanup.browse.sortByField',
              'Sort by {{value0}}',
              { value0: getWorkspaceCleanupSortFieldLabel(sort.field) }
            )}
          >
            <ChevronsUpDown className="size-3" />
            {translate('components.workspace.cleanup.browse.sortByField', 'Sort by {{value0}}', {
              value0: getWorkspaceCleanupSortFieldLabel(sort.field)
            })}
            <SortDirectionIcon direction={sort.direction} />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuLabel>
            {translate('components.workspace.cleanup.browse.sortBy', 'Sort by')}
          </DropdownMenuLabel>
          {WORKSPACE_CLEANUP_SORT_FIELD_VALUES.map((field) => (
            <DropdownMenuItem key={field} onSelect={() => onToggleSortField(field)}>
              <span className="flex-1">{getWorkspaceCleanupSortFieldLabel(field)}</span>
              {sort.field === field ? <SortDirectionIcon direction={sort.direction} /> : null}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

function SortDirectionIcon({ direction }: { direction: 'asc' | 'desc' }): React.JSX.Element {
  return direction === 'asc' ? (
    <ArrowUp className="size-3" aria-hidden="true" />
  ) : (
    <ArrowDown className="size-3" aria-hidden="true" />
  )
}
