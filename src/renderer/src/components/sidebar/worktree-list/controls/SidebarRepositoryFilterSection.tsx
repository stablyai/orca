import React, { useCallback, useMemo } from 'react'
import { useAppStore } from '@/store'
import {
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger
} from '@/components/ui/dropdown-menu'
import { SidebarProjectFilterPanel } from './SidebarProjectFilterPanel'
import { isProjectFilterEntrySelected } from '../../../../../../shared/sidebar-list/sections/project-filter-entries'
import { useProjectFilterEntries, type RepoProjectFilterEntry } from './use-project-filter-entries'
import { withoutHiddenRepos } from '../../../../../../shared/project/catalog/hidden-projects'
import { translate } from '@/i18n/i18n'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { useUiLanguageRevision } from '@/i18n/use-ui-language-revision'

function getProjectFilterVisibilityLabel(
  {
    selectedCount,
    selectedEntries
  }: {
    selectedCount: number
    selectedEntries: readonly RepoProjectFilterEntry[]
  },
  t: Translate = translate
): string {
  if (selectedCount === 0) {
    return t('auto.components.sidebar.SidebarRepositoryFilterSection.allProjects', 'All projects')
  }
  if (selectedCount === 1 && selectedEntries[0]) {
    return selectedEntries[0].label
  }
  return t(
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
  /** Lists hidden projects too, for views (Agents) that still show their work. */
  includeHidden?: boolean
}

const SidebarRepositoryFilterSection = React.memo(function SidebarRepositoryFilterSection({
  preserveWorkspaceBoardOpen = false,
  filterRepoIds: filterRepoIdsProp,
  setFilterRepoIds: setFilterRepoIdsProp,
  includeHidden = false
}: SidebarRepositoryFilterSectionProps) {
  const t = useTranslate()
  useUiLanguageRevision()
  const workspaceFilterRepoIds = useAppStore((s) => s.filterRepoIds)
  const setWorkspaceFilterRepoIds = useAppStore((s) => s.setFilterRepoIds)
  const allRepos = useAppStore((s) => s.repos)
  const repos = useMemo(
    () => (includeHidden ? allRepos : withoutHiddenRepos(allRepos)),
    [allRepos, includeHidden]
  )
  const filterRepoIds = filterRepoIdsProp ?? workspaceFilterRepoIds
  const setFilterRepoIds = setFilterRepoIdsProp ?? setWorkspaceFilterRepoIds

  const entries = useProjectFilterEntries(repos)
  // Entries come from current repos, so removed repo IDs cannot imply a stale active filter.
  const selectedEntries = useMemo(
    () => entries.filter((entry) => isProjectFilterEntrySelected(entry, filterRepoIds)),
    [entries, filterRepoIds]
  )
  const availableEntries = useMemo(
    () => entries.filter((entry) => !isProjectFilterEntrySelected(entry, filterRepoIds)),
    [entries, filterRepoIds]
  )
  const selectedCount = selectedEntries.length
  const hasRepoFilter = selectedCount > 0
  // Keep the section while a filter is active, even when grouping leaves a single project.
  const canFilterRepos = entries.length > 1 || hasRepoFilter
  const visibilityLabel = getProjectFilterVisibilityLabel({ selectedCount, selectedEntries }, t)

  const clearRepos = useCallback(() => setFilterRepoIds([]), [setFilterRepoIds])

  if (!canFilterRepos) {
    return null
  }

  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <span className="flex flex-1 items-center justify-between gap-3">
          <span>
            {t('auto.components.sidebar.SidebarRepositoryFilterSection.7679f0c268', 'Projects')}
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
            {t('auto.components.sidebar.SidebarRepositoryFilterSection.7679f0c268', 'Projects')}
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
            {t('auto.components.sidebar.SidebarRepositoryFilterSection.d3a9c4cea1', 'Clear')}
          </button>
        </div>

        <SidebarProjectFilterPanel
          availableEntries={availableEntries}
          selectedEntries={selectedEntries}
          hasRepoFilter={hasRepoFilter}
          filterRepoIds={filterRepoIds}
          setFilterRepoIds={setFilterRepoIds}
        />
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
})

export default SidebarRepositoryFilterSection
