import React, { useCallback, useMemo } from 'react'
import { useAppStore } from '@/store'
import {
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger
} from '@/components/ui/dropdown-menu'
import { SidebarProjectFilterPanel } from './SidebarProjectFilterPanel'
import {
  getSidebarProjectFilterGroups,
  isSidebarProjectGroupSelected,
  type SidebarProjectFilterGroup
} from './sidebar-project-filter-groups'
import { translate } from '@/i18n/i18n'
import { useUiLanguageRevision } from '@/i18n/use-ui-language-revision'

function getProjectFilterVisibilityLabel({
  selectedCount,
  selectedGroups
}: {
  selectedCount: number
  selectedGroups: readonly SidebarProjectFilterGroup[]
}): string {
  if (selectedCount === 0) {
    return translate(
      'auto.components.sidebar.SidebarRepositoryFilterSection.allProjects',
      'All projects'
    )
  }
  if (selectedCount === 1 && selectedGroups[0]) {
    return selectedGroups[0].repo.displayName
  }
  return translate(
    'auto.components.sidebar.SidebarRepositoryFilterSection.selectedProjects',
    '{{count}} projects',
    { count: selectedCount, defaultValue_one: '{{count}} project' }
  )
}

type SidebarRepositoryFilterSectionProps = {
  preserveWorkspaceBoardOpen?: boolean
  // Agents inject their own persisted filter; workspace navigation supplies the defaults.
  filterRepoIds?: readonly string[]
  setFilterRepoIds?: (ids: string[]) => void
}

const SidebarRepositoryFilterSection = React.memo(function SidebarRepositoryFilterSection({
  preserveWorkspaceBoardOpen = false,
  filterRepoIds: filterRepoIdsProp,
  setFilterRepoIds: setFilterRepoIdsProp
}: SidebarRepositoryFilterSectionProps) {
  useUiLanguageRevision()
  const workspaceFilterRepoIds = useAppStore((s) => s.filterRepoIds)
  const setWorkspaceFilterRepoIds = useAppStore((s) => s.setFilterRepoIds)
  const repos = useAppStore((s) => s.repos)
  const filterRepoIds = filterRepoIdsProp ?? workspaceFilterRepoIds
  const setFilterRepoIds = setFilterRepoIdsProp ?? setWorkspaceFilterRepoIds

  const projectGroups = useMemo(() => getSidebarProjectFilterGroups(repos), [repos])
  const canFilterRepos = projectGroups.length > 1
  // Ignore removed repo IDs so counts cannot imply a stale active filter.
  const selectedRepoIdSet = useMemo(() => {
    const set = new Set<string>()
    for (const repo of repos) {
      if (filterRepoIds.includes(repo.id)) {
        set.add(repo.id)
      }
    }
    return set
  }, [repos, filterRepoIds])
  const selectedGroups = useMemo(
    () => projectGroups.filter((group) => isSidebarProjectGroupSelected(group, selectedRepoIdSet)),
    [projectGroups, selectedRepoIdSet]
  )
  const availableGroups = useMemo(
    () => projectGroups.filter((group) => !isSidebarProjectGroupSelected(group, selectedRepoIdSet)),
    [projectGroups, selectedRepoIdSet]
  )
  const selectedCount = selectedGroups.length
  const hasRepoFilter = selectedCount > 0
  const visibilityLabel = getProjectFilterVisibilityLabel({ selectedCount, selectedGroups })

  const clearRepos = useCallback(() => setFilterRepoIds([]), [setFilterRepoIds])

  if (!canFilterRepos) {
    return null
  }

  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <span className="flex flex-1 items-center justify-between gap-3">
          <span>
            {translate(
              'auto.components.sidebar.SidebarRepositoryFilterSection.7679f0c268',
              'Projects'
            )}
          </span>
          <span className="min-w-0 truncate text-[11px] font-medium text-muted-foreground">
            {visibilityLabel}
          </span>
        </span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent
        className="w-64"
        data-workspace-board-preserve-open={preserveWorkspaceBoardOpen ? '' : undefined}
      >
        <div className="flex items-center justify-between px-2 py-1">
          <span className="text-[11px] font-semibold text-muted-foreground">
            {translate(
              'auto.components.sidebar.SidebarRepositoryFilterSection.7679f0c268',
              'Projects'
            )}
            {hasRepoFilter && (
              <span className="ml-1.5 font-medium text-foreground">· {selectedCount}</span>
            )}
          </span>
          <button
            type="button"
            onClick={clearRepos}
            className="rounded-full px-2 py-0.5 text-[11px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-40 disabled:hover:bg-transparent"
            disabled={!hasRepoFilter}
          >
            {translate(
              'auto.components.sidebar.SidebarRepositoryFilterSection.d3a9c4cea1',
              'Clear'
            )}
          </button>
        </div>

        <SidebarProjectFilterPanel
          availableGroups={availableGroups}
          selectedGroups={selectedGroups}
          hasRepoFilter={hasRepoFilter}
          filterRepoIds={filterRepoIds}
          setFilterRepoIds={setFilterRepoIds}
        />
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
})

export default SidebarRepositoryFilterSection
