// Pure sort-state helpers for the data grid. A header click cycles the clicked
// column through asc → desc → unsorted (single-column sort, mirroring the
// github-project list). Kept pure so the tri-state cycle is unit-testable.

import type { DbColumnSort, DbOrdinalSort, DbSortDirection } from '../../../../shared/database-types'

// Cycle the clicked column: unsorted → asc → desc → unsorted. Sorting a
// different column starts it fresh at asc (replacing the prior single sort).
export function cycleColumnSort(sorts: DbColumnSort[], column: string): DbColumnSort[] {
  const current = sorts[0]
  if (!current || current.column !== column) {
    return [{ column, direction: 'asc' }]
  }
  if (current.direction === 'asc') {
    return [{ column, direction: 'desc' }]
  }
  return []
}

// The active direction for a column, or null when it isn't the sorted column.
export function sortDirectionFor(sorts: DbColumnSort[], column: string): DbSortDirection | null {
  const current = sorts[0]
  return current && current.column === column ? current.direction : null
}

// Ordinal-position variant for free-form results (wrapped subquery ORDER BY <n>),
// which survives duplicate output column names that ORDER BY <name> cannot.
export function cycleOrdinalSort(
  current: DbOrdinalSort | null,
  ordinal: number
): DbOrdinalSort | null {
  if (!current || current.ordinal !== ordinal) {
    return { ordinal, direction: 'asc' }
  }
  if (current.direction === 'asc') {
    return { ordinal, direction: 'desc' }
  }
  return null
}

export function ordinalSortDirectionFor(
  sort: DbOrdinalSort | null,
  ordinal: number
): DbSortDirection | null {
  return sort && sort.ordinal === ordinal ? sort.direction : null
}
