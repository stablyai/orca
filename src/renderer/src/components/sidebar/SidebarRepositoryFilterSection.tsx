import React, { useCallback } from 'react'
import { useProjectFilterOptions } from './use-project-filter-options'
import { useAppStore } from '@/store'
import {
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger
} from '@/components/ui/dropdown-menu'
import { SidebarProjectFilterPanel } from './SidebarProjectFilterPanel'
import type { Repo } from '../../../../shared/repo-types'
import { translate } from '@/i18n/i18n'
import { useUiLanguageRevision } from '@/i18n/use-ui-language-revision'

function getProjectFilterVisibilityLabel({
  selectedCount,
  selectedRepos
}: {
  selectedCount: number
  selectedRepos: readonly Repo[]
}): string {
  if (selectedCount === 0) {
    return translate(
      'auto.components.sidebar.SidebarRepositoryFilterSection.allProjects',
      'All projects'
    )
  }
  if (selectedCount === 1 && selectedRepos[0]) {
    return selectedRepos[0].displayName
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
  const filterRepoIds = filterRepoIdsProp ?? workspaceFilterRepoIds
  const setFilterRepoIds = setFilterRepoIdsProp ?? setWorkspaceFilterRepoIds
  const {
    repos: groupedRepos,
    selection,
    edit,
    ready
  } = useProjectFilterOptions(filterRepoIds, filterRepoIdsProp !== undefined)
  const canFilterRepos = groupedRepos.length > 1 || selection.active
  const selectedCount = selection.matchingKeys.length
  const hasRepoFilter = selection.active
  const selectedRepos = groupedRepos.filter((repo) => selection.matching.has(repo.id))
  const availableRepos = groupedRepos.filter((repo) => !selection.full.has(repo.id))
  const visibilityLabel =
    selection.active && !selectedCount
      ? translate('projects.savedSelection', 'Saved project selection')
      : getProjectFilterVisibilityLabel({ selectedCount, selectedRepos })

  const clearRepos = useCallback(() => setFilterRepoIds([]), [setFilterRepoIds])

  if (!canFilterRepos) {
    return null
  }

  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger disabled={!ready}>
        <span className="flex flex-1 items-center justify-between gap-3">
          <span>
            {translate(
              'auto.components.sidebar.SidebarRepositoryFilterSection.7679f0c268',
              'Projects'
            )}
          </span>
          <span className="min-w-0 truncate text-[11px] font-medium text-muted-foreground">
            {visibilityLabel}
            {selection.partialKeys.length > 0 && (
              <> · {translate('projects.partiallySelected', 'Partially selected')}</>
            )}
            {selection.unresolved.length > 0 && (
              <> · {translate('projects.unavailable', 'Unavailable projects')}</>
            )}
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
            {hasRepoFilter && selectedCount > 0 && (
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
          availableRepos={availableRepos}
          selectedRepos={selectedRepos}
          hasRepoFilter={hasRepoFilter}
          partialKeys={selection.partial}
          unavailable={selection.unresolved.length > 0}
          onComplete={(id) => setFilterRepoIds(edit('complete', [id]))}
          onRemove={(id) => setFilterRepoIds(edit('remove', [id]))}
        />
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
})

export default SidebarRepositoryFilterSection
