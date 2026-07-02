// Per-column filter model for the data grid: the operator catalog the popover
// renders and pure helpers to read/replace a single column's predicate. Kept
// pure + string-literal (operators are SQL symbols, not translatable copy).

import type { DbColumnFilter, DbFilterOperator } from '../../../../shared/database-types'

export type DbFilterOperatorMeta = {
  value: DbFilterOperator
  label: string
  takesValue: boolean
}

// Order shown in the operator dropdown. `takesValue:false` hides the value input.
export const DB_FILTER_OPERATORS: DbFilterOperatorMeta[] = [
  { value: '=', label: '=', takesValue: true },
  { value: '<>', label: '≠', takesValue: true },
  { value: '<', label: '<', takesValue: true },
  { value: '<=', label: '≤', takesValue: true },
  { value: '>', label: '>', takesValue: true },
  { value: '>=', label: '≥', takesValue: true },
  { value: 'like', label: 'LIKE', takesValue: true },
  { value: 'ilike', label: 'ILIKE', takesValue: true },
  { value: 'is-null', label: 'IS NULL', takesValue: false },
  { value: 'is-not-null', label: 'IS NOT NULL', takesValue: false }
]

export function operatorTakesValue(operator: DbFilterOperator): boolean {
  return DB_FILTER_OPERATORS.find((o) => o.value === operator)?.takesValue ?? true
}

export function filterFor(
  filters: DbColumnFilter[],
  column: string
): DbColumnFilter | undefined {
  return filters.find((f) => f.column === column)
}

// Replace (or, with null, clear) the predicate for one column, preserving the
// order of the others. At most one filter per column.
export function setColumnFilter(
  filters: DbColumnFilter[],
  column: string,
  filter: DbColumnFilter | null
): DbColumnFilter[] {
  const rest = filters.filter((f) => f.column !== column)
  return filter ? [...rest, filter] : rest
}
