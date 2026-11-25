import React, { useMemo } from 'react'
import { Server } from 'lucide-react'
import { useAppStore } from '@/store'
import RepoBadgeLabel from '@/components/repo/RepoBadgeLabel'
import { searchRepos } from '@/lib/workspace/catalog/repo-search'
import { SidebarScopeFilterMenu } from './SidebarScopeFilterMenu'
import type { Repo } from '../../../../../../shared/repository/repo-types'
import { withoutHiddenRepos } from '../../../../../../shared/project/catalog/hidden-projects'
import { translate } from '@/i18n/i18n'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { useUiLanguageRevision } from '@/i18n/use-ui-language-revision'

function getProjectFilterVisibilityLabel(
  {
    selectedCount,
    selectedRepos
  }: {
    selectedCount: number
    selectedRepos: readonly Repo[]
  },
  t: Translate = translate
): string {
  if (selectedCount === 0) {
    return t('auto.components.sidebar.SidebarRepositoryFilterSection.allProjects', 'All projects')
  }
  if (selectedCount === 1 && selectedRepos[0]) {
    return selectedRepos[0].displayName
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

  // Ignore removed repo IDs so counts cannot imply a stale active filter.
  const selectedRepos = repos.filter((repo) => filterRepoIds.includes(repo.id))
  if (repos.length < 2) {
    return null
  }

  return (
    <SidebarScopeFilterMenu
      title={t('auto.components.sidebar.SidebarRepositoryFilterSection.7679f0c268', 'Projects')}
      visibilityLabel={getProjectFilterVisibilityLabel(
        { selectedCount: selectedRepos.length, selectedRepos },
        t
      )}
      options={repos}
      selectedIds={filterRepoIds}
      onChange={setFilterRepoIds}
      placeholders={{
        filter: t(
          'auto.components.sidebar.SidebarRepositoryFilterSection.83a820fa71',
          'Filter projects...'
        ),
        add: t(
          'auto.components.sidebar.SidebarRepositoryFilterSection.5a273fbfce',
          'Add project...'
        )
      }}
      emptyMessages={{
        unfiltered: t(
          'auto.components.sidebar.SidebarRepositoryFilterSection.4815c70605',
          'No projects match'
        ),
        filtered: t(
          'auto.components.sidebar.SidebarRepositoryFilterSection.bbbc6e8e3b',
          'No unselected projects match'
        )
      }}
      getLabel={(repo) => repo.displayName}
      getSearchDetail={(repo) => repo.path}
      findFirstMatch={(available, query) => searchRepos(available, query)[0]}
      renderOption={(repo, selected) =>
        selected ? (
          <RepoBadgeLabel
            name={repo.displayName}
            color={repo.badgeColor}
            repo={repo}
            className="max-w-[8rem]"
          />
        ) : (
          <span className="inline-flex min-w-0 flex-1 items-center gap-1.5">
            <RepoBadgeLabel
              name={repo.displayName}
              color={repo.badgeColor}
              repo={repo}
              className="max-w-full"
            />
            {repo.connectionId && (
              <span className="shrink-0 inline-flex items-center gap-0.5 rounded bg-muted px-1 py-0.5 text-[9px] font-medium leading-none text-muted-foreground">
                <Server className="size-2.5" />
                {t('auto.components.sidebar.SidebarRepositoryFilterSection.2656053db4', 'SSH')}
              </span>
            )}
          </span>
        )
      }
      preserveWorkspaceBoardOpen={preserveWorkspaceBoardOpen}
    />
  )
})

export default SidebarRepositoryFilterSection
