import type { ProjectGroup } from '../project-group-types'
import type { ServedProjectSections } from '../project-section-catalog-schema'
import type { ProjectSectionRepo } from '../project-section-grouping'
import type { Repo } from '../repo-types'
import type { SidebarFeedCatalog } from './sidebar-feed-rows'

/** A repo as a served catalog or a host's repo.list names it, before the builder reads it. */
export type SidebarCatalogRepo = ProjectSectionRepo &
  Partial<Pick<Repo, 'badgeColor' | 'projectGroupId' | 'projectGroupOrder'>>

function catalogRepo(repo: SidebarCatalogRepo): Repo {
  return {
    id: repo.id,
    path: repo.path,
    displayName: repo.displayName,
    badgeColor: repo.badgeColor ?? '',
    addedAt: repo.addedAt ?? 0,
    ...(repo.connectionId !== undefined ? { connectionId: repo.connectionId } : {}),
    ...(repo.executionHostId ? { executionHostId: repo.executionHostId } : {}),
    ...(repo.projectGroupId ? { projectGroupId: repo.projectGroupId } : {}),
    ...(repo.projectGroupOrder !== undefined ? { projectGroupOrder: repo.projectGroupOrder } : {})
  }
}

/** Use served all-host catalogs when available, otherwise the host’s own repos/groups. */
export function buildSidebarFeedCatalog(
  served: ServedProjectSections | null,
  hostRepos: readonly SidebarCatalogRepo[],
  hostProjectGroups: readonly ProjectGroup[]
): SidebarFeedCatalog {
  return served
    ? {
        repos: served.repos.map(catalogRepo),
        projectGroups: served.projectGroups ?? hostProjectGroups,
        projectGrouping: { projects: served.projects, projectHostSetups: served.setups }
      }
    : {
        repos: hostRepos.map(catalogRepo),
        projectGroups: hostProjectGroups,
        projectGrouping: { projects: [], projectHostSetups: [] }
      }
}
