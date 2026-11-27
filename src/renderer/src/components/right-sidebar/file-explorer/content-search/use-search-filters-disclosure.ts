import { useState } from 'react'

/** Open state and summary for a worktree's include/exclude filters. */
export function useSearchFiltersDisclosure(
  worktreeId: string | null,
  includePattern: string,
  excludePattern: string
): { filtersOpen: boolean; filterSummary: string; onToggleFilters: () => void } {
  const filterSummary = [
    includePattern.trim(),
    excludePattern.trim() && `!${excludePattern.trim()}`
  ]
    .filter(Boolean)
    .join(', ')
  // Why: each worktree opens with its filters shown only if it has some.
  const [state, setState] = useState({ worktreeId, open: filterSummary.length > 0 })
  const filtersOpen = state.worktreeId === worktreeId ? state.open : filterSummary.length > 0
  return {
    filtersOpen,
    filterSummary,
    onToggleFilters: () => setState({ worktreeId, open: !filtersOpen })
  }
}
