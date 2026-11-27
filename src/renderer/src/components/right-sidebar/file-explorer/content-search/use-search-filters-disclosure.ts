import { useId, useState } from 'react'

/** Open state, summary and region id for a worktree's include/exclude filters. */
export function useSearchFiltersDisclosure(
  worktreeId: string | null,
  includePattern: string,
  excludePattern: string
): {
  queryRow: {
    filtersOpen: boolean
    filterSummary: string
    filtersRegionId: string
    onToggleFilters: () => void
  }
  filters: { open: boolean; regionId: string }
} {
  const regionId = useId()
  const filterSummary = [
    includePattern.trim(),
    excludePattern.trim() && `!${excludePattern.trim()}`
  ]
    .filter(Boolean)
    .join(', ')
  const hasFilters = filterSummary.length > 0
  const [state, setState] = useState({ worktreeId, open: hasFilters })
  // Why: each visit to a worktree starts open only if it has filters, as the old remount did.
  if (state.worktreeId !== worktreeId) {
    setState({ worktreeId, open: hasFilters })
  }
  const open = state.worktreeId === worktreeId ? state.open : hasFilters
  return {
    queryRow: {
      filtersOpen: open,
      filterSummary,
      filtersRegionId: regionId,
      onToggleFilters: () => setState({ worktreeId, open: !open })
    },
    filters: { open, regionId }
  }
}
