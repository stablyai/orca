import { useId, useState } from 'react'
import { useTranslate } from '@/i18n/use-translate'

/** Labels the include and exclude lists separately, e.g. "Include: src/** · Exclude: dist/**"; empty when none. */
export function useSearchFilterSummary(includePattern: string, excludePattern: string): string {
  const t = useTranslate()
  const include = includePattern.trim()
  const exclude = excludePattern.trim()
  return [
    include &&
      t('fileSearch.filters.includeSummary', 'Include: {{patterns}}', { patterns: include }),
    exclude &&
      t('fileSearch.filters.excludeSummary', 'Exclude: {{patterns}}', { patterns: exclude })
  ]
    .filter(Boolean)
    .join(' · ')
}

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
  const filterSummary = useSearchFilterSummary(includePattern, excludePattern)
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
