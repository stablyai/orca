import { useCallback, useMemo, useState } from 'react'

import type { GlpiWorkItemFilters } from '../../../shared/types'

export type GlpiTypeFilter = 'all' | 'incident' | 'request'

export type GlpiAdvancedFilters = {
  text?: string
  category?: string
  priority?: number
}

export type UseGlpiWorkItemFiltersResult = {
  glpiTypeFilter: GlpiTypeFilter
  setGlpiTypeFilter: (type: GlpiTypeFilter) => void
  glpiAdvancedFilters: GlpiAdvancedFilters
  setGlpiAdvancedFilters: (filters: GlpiAdvancedFilters) => void
  glpiHasActiveFilters: boolean
  derivedGlpiFilters: GlpiWorkItemFilters
}

// Why: trim free-text fields so whitespace-only input doesn't widen the GLPI
// search; an empty string must collapse to `undefined` to drop the criterion.
function trimmedOrUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

// Owns the GLPI list narrowing state (ticket type + advanced fields) and the
// derived GlpiWorkItemFilters payload passed to listGlpiWorkItems. Kept in a
// sibling module so task-page-glpi-handlers stays under its line budget.
export function useGlpiWorkItemFilters(): UseGlpiWorkItemFiltersResult {
  const [glpiTypeFilter, setGlpiTypeFilter] = useState<GlpiTypeFilter>('all')
  const [glpiAdvancedFilters, setGlpiAdvancedFilters] = useState<GlpiAdvancedFilters>({})

  const text = trimmedOrUndefined(glpiAdvancedFilters.text)
  const category = trimmedOrUndefined(glpiAdvancedFilters.category)
  const priority = glpiAdvancedFilters.priority || undefined

  // Type is omitted entirely when 'all' so the backend keeps the full scope.
  const derivedGlpiFilters = useMemo<GlpiWorkItemFilters>(
    () => ({
      ...(glpiTypeFilter !== 'all' ? { type: glpiTypeFilter } : {}),
      ...(text ? { text } : {}),
      ...(category ? { category } : {}),
      ...(priority ? { priority } : {})
    }),
    [glpiTypeFilter, text, category, priority]
  )

  const glpiHasActiveFilters =
    glpiTypeFilter !== 'all' ||
    text !== undefined ||
    category !== undefined ||
    priority !== undefined

  const setGlpiAdvancedFiltersStable = useCallback((filters: GlpiAdvancedFilters) => {
    setGlpiAdvancedFilters(filters)
  }, [])

  return {
    glpiTypeFilter,
    setGlpiTypeFilter,
    glpiAdvancedFilters,
    setGlpiAdvancedFilters: setGlpiAdvancedFiltersStable,
    glpiHasActiveFilters,
    derivedGlpiFilters
  }
}
