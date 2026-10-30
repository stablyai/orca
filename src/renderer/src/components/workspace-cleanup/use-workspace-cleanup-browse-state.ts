import { useCallback } from 'react'
import { useAppStore } from '@/store'
import {
  createDefaultWorkspaceCleanupFilterState,
  type WorkspaceCleanupFilterState,
  type WorkspaceCleanupSortField,
  type WorkspaceCleanupSortState
} from '../../../../shared/workspace-cleanup-filter-model'

export type WorkspaceCleanupBrowseController = {
  filters: WorkspaceCleanupFilterState
  sort: WorkspaceCleanupSortState
  patchFilters: <K extends keyof WorkspaceCleanupFilterState>(
    key: K,
    value: Partial<WorkspaceCleanupFilterState[K]> | WorkspaceCleanupFilterState[K]
  ) => void
  toggleSortField: (field: WorkspaceCleanupSortField) => void
  clearFilters: () => void
  replaceFilters: (
    transform: (filters: WorkspaceCleanupFilterState) => WorkspaceCleanupFilterState
  ) => void
}

export function useWorkspaceCleanupBrowseState(): WorkspaceCleanupBrowseController {
  const browse = useAppStore((s) => s.workspaceCleanupBrowse)
  const updateBrowse = useAppStore((s) => s.updateWorkspaceCleanupBrowseState)

  // Functional updates merge same-tick patches instead of overwriting from a stale render snapshot.
  const patchFilters = useCallback<WorkspaceCleanupBrowseController['patchFilters']>(
    (key, value) => {
      updateBrowse((current) => {
        const group = current.filters[key]
        const next =
          typeof group === 'object' && group !== null ? { ...group, ...(value as object) } : value
        // Cast: a computed key over a union widens the spread result past
        // WorkspaceCleanupFilterState even though `key` is constrained to it.
        const filters = { ...current.filters, [key]: next } as WorkspaceCleanupFilterState
        return { ...current, filters }
      })
    },
    [updateBrowse]
  )

  // Why: re-picking the active sort flips its direction.
  const toggleSortField = useCallback(
    (field: WorkspaceCleanupSortField) => {
      updateBrowse((current) => {
        const direction =
          current.sort.field === field && current.sort.direction === 'asc' ? 'desc' : 'asc'
        return { ...current, sort: { field, direction } }
      })
    },
    [updateBrowse]
  )

  // Facet patches and chip clears can share a tick; merge through the same functional-update path.
  const replaceFilters = useCallback<WorkspaceCleanupBrowseController['replaceFilters']>(
    (transform) => {
      updateBrowse((current) => ({ ...current, filters: transform(current.filters) }))
    },
    [updateBrowse]
  )

  const clearFilters = useCallback(() => {
    updateBrowse((current) => ({
      ...current,
      filters: createDefaultWorkspaceCleanupFilterState()
    }))
  }, [updateBrowse])

  return {
    filters: browse.filters,
    sort: browse.sort,
    patchFilters,
    toggleSortField,
    clearFilters,
    replaceFilters
  }
}
