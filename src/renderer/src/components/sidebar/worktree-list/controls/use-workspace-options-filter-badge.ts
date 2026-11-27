import { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import { countActiveWorkspaceFilters } from '../../../../../../shared/workspace-view/workspace-row-filters'
import { withoutHiddenRepos } from '../../../../../../shared/project/catalog/hidden-projects'
import { selectSidebarFilterState, sidebarWorkspaceRowFilters } from './sidebar-filter-actions'

export function useWorkspaceOptionsFilterBadge(): {
  hasAnyFilter: boolean
  activeFilterCount: number
} {
  const filterState = useAppStore(useShallow(selectSidebarFilterState))
  const repos = useAppStore((s) => s.repos)
  const activeFilterCount = useMemo(
    () =>
      countActiveWorkspaceFilters(
        sidebarWorkspaceRowFilters(filterState),
        // A filter id with no listed copy filters nothing, so it does not count.
        withoutHiddenRepos(repos).map((repo) => repo.id)
      ),
    [filterState, repos]
  )
  return {
    hasAnyFilter: activeFilterCount > 0,
    activeFilterCount
  }
}
