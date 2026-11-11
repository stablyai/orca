import React from 'react'
import { ArrowDown, ArrowUp, ChevronsUpDown, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { useTranslate } from '@/i18n/use-translate'
import { WORKSPACE_CLEANUP_SORT_FIELD_VALUES } from '../../../../shared/workspace-cleanup/workspace-cleanup-facet-rankings'
import type {
  WorkspaceCleanupSortField,
  WorkspaceCleanupSortState
} from '../../../../shared/workspace-cleanup/workspace-cleanup-filter-model'
import { getWorkspaceCleanupSortFieldLabel } from './workspace-cleanup-facet-labels'

export function WorkspaceCleanupSortHeader({
  sort,
  selectableCount,
  selectedSelectableCount,
  selectedCount,
  deleteDisabled,
  onToggleSortField,
  onToggleSelectAll,
  onDeleteSelected
}: {
  sort: WorkspaceCleanupSortState
  selectableCount: number
  /** Visible selected rows; drives the select-all checkbox state. */
  selectedSelectableCount: number
  /** Every selected row, including ones hidden by filters; what Delete acts on. */
  selectedCount: number
  deleteDisabled: boolean
  onToggleSortField: (field: WorkspaceCleanupSortField) => void
  onToggleSelectAll: (selectAll: boolean) => void
  onDeleteSelected: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const allSelected = selectableCount > 0 && selectedSelectableCount >= selectableCount
  const someSelected = selectableCount > 0 && selectedSelectableCount > 0 && !allSelected
  const selectAllLabel = t(
    'components.workspace.cleanup.browse.selectAllSafetyChecked',
    'Select all {{count}} safety-checked workspaces',
    { count: selectableCount, defaultValue_one: 'Select {{count}} safety-checked workspace' }
  )
  return (
    <div className="flex h-13 items-center gap-2 border-b border-border bg-muted/25 px-4">
      <Checkbox
        checked={someSelected ? 'indeterminate' : allSelected}
        disabled={selectableCount === 0}
        aria-label={selectAllLabel}
        onCheckedChange={() => onToggleSelectAll(!allSelected)}
      />
      {/* Bulk action sits beside the selection it acts on; it appears once something is selected. */}
      {selectedCount > 0 ? (
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <span className="truncate text-xs font-medium text-foreground">
            {t('components.workspace.cleanup.browse.selectedCount', '{{value0}} selected', {
              value0: selectedCount
            })}
          </span>
          <Button
            variant="outline"
            size="xs"
            className="shrink-0"
            onClick={onDeleteSelected}
            disabled={deleteDisabled}
          >
            <Trash2 className="size-3 text-destructive" />
            {t(
              'auto.components.workspace.cleanup.WorkspaceCleanupDialog.b771c92598',
              'Delete selected'
            )}
          </Button>
        </div>
      ) : (
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          {selectAllLabel}
        </span>
      )}
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="xs"
            className="shrink-0 text-[11px] text-muted-foreground"
            aria-label={t('components.workspace.cleanup.browse.sortByField', 'Sort by {{value0}}', {
              value0: getWorkspaceCleanupSortFieldLabel(sort.field, t)
            })}
          >
            <ChevronsUpDown className="size-3" />
            {t('components.workspace.cleanup.browse.sortByField', 'Sort by {{value0}}', {
              value0: getWorkspaceCleanupSortFieldLabel(sort.field, t)
            })}
            <SortDirectionIcon direction={sort.direction} />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuLabel>
            {t('components.workspace.cleanup.browse.sortBy', 'Sort by')}
          </DropdownMenuLabel>
          {WORKSPACE_CLEANUP_SORT_FIELD_VALUES.map((field) => (
            <DropdownMenuItem key={field} onSelect={() => onToggleSortField(field)}>
              <span className="flex-1">{getWorkspaceCleanupSortFieldLabel(field, t)}</span>
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
