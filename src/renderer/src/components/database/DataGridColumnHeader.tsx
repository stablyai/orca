import React from 'react'
import { ArrowDown, ArrowUp, ChevronsUpDown, KeyRound } from 'lucide-react'
import type { DbColumnFilter, DbSortDirection } from '../../../../shared/database-types'
import { DataGridColumnFilter } from './data-grid-column-filter'

// One sortable/filterable header cell, shared by the table Data grid and (Phase 4)
// the free-form results grid. Sort is a tri-state toggle; the funnel opens the
// per-column filter popover. Both are opt-out via `sortable`/`filterable`.
export function DataGridColumnHeader({
  name,
  dataType,
  isPrimaryKey,
  sortDirection,
  onSort,
  filter,
  onFilter,
  sortable = true,
  filterable = true
}: {
  name: string
  dataType?: string
  isPrimaryKey?: boolean
  sortDirection: DbSortDirection | null
  onSort?: () => void
  filter?: DbColumnFilter
  onFilter?: (filter: DbColumnFilter | null) => void
  sortable?: boolean
  filterable?: boolean
}): React.JSX.Element {
  const SortIcon =
    sortDirection === 'asc' ? ArrowUp : sortDirection === 'desc' ? ArrowDown : ChevronsUpDown
  return (
    <div
      className="group flex h-full items-center gap-1 border-r border-border/60 px-2 font-medium"
      title={dataType ? `${name} · ${dataType}` : name}
    >
      <button
        type="button"
        disabled={!sortable}
        onClick={onSort}
        className="flex min-w-0 flex-1 items-center gap-1 text-left disabled:cursor-default"
      >
        {isPrimaryKey ? (
          <KeyRound className="size-3 shrink-0 text-amber-500" aria-hidden="true" />
        ) : null}
        <span className="truncate">{name}</span>
        {sortable ? (
          <SortIcon
            className={`size-3 shrink-0 ${
              sortDirection
                ? 'text-foreground'
                : 'text-muted-foreground/40 opacity-0 group-hover:opacity-100'
            }`}
          />
        ) : null}
      </button>
      {filterable && onFilter ? (
        <DataGridColumnFilter column={name} filter={filter} onApply={onFilter} />
      ) : null}
    </div>
  )
}
