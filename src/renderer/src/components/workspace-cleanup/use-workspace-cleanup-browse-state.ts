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
}

/**
 * Single seam over the persisted browse slice so reopening the dialog keeps the
 * user's filters and sort.
 */
export function useWorkspaceCleanupBrowseState(): WorkspaceCleanupBrowseController {
  const browse = useAppStore((s) => s.workspaceCleanupBrowse)
  const updateBrowse = useAppStore((s) => s.updateWorkspaceCleanupBrowseState)

  const patchFilters = useCallback<WorkspaceCleanupBrowseController['patchFilters']>(
    (key, value) => {
      const current = browse.filters[key]
      const next =
        typeof current === 'object' && current !== null
          ? { ...current, ...(value as object) }
          : value
      // Cast: a computed key over a union widens the spread result past
      // WorkspaceCleanupFilterState even though `key` is constrained to it.
      const filters = { ...browse.filters, [key]: next } as WorkspaceCleanupFilterState
      updateBrowse({ ...browse, filters })
    },
    [browse, updateBrowse]
  )

  // Why: re-picking the active sort flips its direction.
  const toggleSortField = useCallback(
    (field: WorkspaceCleanupSortField) => {
      const direction =
        browse.sort.field === field && browse.sort.direction === 'asc' ? 'desc' : 'asc'
      updateBrowse({ ...browse, sort: { field, direction } })
    },
    [browse, updateBrowse]
  )

  const clearFilters = useCallback(() => {
    updateBrowse({
      ...browse,
      filters: createDefaultWorkspaceCleanupFilterState()
    })
  }, [browse, updateBrowse])

  return {
    filters: browse.filters,
    sort: browse.sort,
    patchFilters,
    toggleSortField,
    clearFilters
  }
}
