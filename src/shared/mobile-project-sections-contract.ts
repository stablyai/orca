import type { ProjectHostSetupProjection } from './project-host-setup-projection'
import type { ProjectSectionProject, ProjectSectionSetup } from './project-section-grouping'
import type { RepoIcon } from './repo-icon'
import type { Repo } from './repo-types'
import type { ProjectOrderBy } from './ui-chrome-types'

// Why the desktop answers it: its sidebar's own grouping inputs, so the phone's Project sections match.
export const MOBILE_PROJECT_SECTIONS_METHOD = 'mobileRelay.projectSections'

/** A sidebar repo as Project sections read it; never its hooks, credentials or AI settings. */
export type MobileProjectSectionRepo = Pick<Repo, 'id' | 'displayName' | 'path' | 'badgeColor'> &
  Partial<Pick<Repo, 'addedAt' | 'connectionId' | 'executionHostId'>> & { repoIcon?: RepoIcon }

export type MobileProjectSectionCatalog = {
  /** Every repo the sidebar holds, across hosts, in its header order. */
  repos: MobileProjectSectionRepo[]
  projects: ProjectSectionProject[]
  setups: ProjectSectionSetup[]
  projectOrderBy: ProjectOrderBy
}

/** Null until a desktop window has published its sidebar catalog. */
export type MobileProjectSectionsResult = { catalog: MobileProjectSectionCatalog | null }

function sectionRepo(repo: Repo): MobileProjectSectionRepo {
  return {
    id: repo.id,
    displayName: repo.displayName,
    path: repo.path,
    badgeColor: repo.badgeColor,
    addedAt: repo.addedAt,
    ...(repo.connectionId !== undefined ? { connectionId: repo.connectionId } : {}),
    ...(repo.executionHostId ? { executionHostId: repo.executionHostId } : {}),
    // Why not uploaded icons: a data URL can be hundreds of KB per repo on every read.
    ...(repo.repoIcon && !(repo.repoIcon.type === 'image' && repo.repoIcon.src.startsWith('data:'))
      ? { repoIcon: repo.repoIcon }
      : {})
  }
}

/** The sidebar's repos, in its order, and the projection its project-header selector produced. */
export function buildMobileProjectSectionCatalog(
  repos: readonly Repo[],
  projection: ProjectHostSetupProjection,
  projectOrderBy: ProjectOrderBy
): MobileProjectSectionCatalog {
  return {
    repos: repos.map(sectionRepo),
    projects: projection.projects.map(({ id, displayName }) => ({ id, displayName })),
    setups: projection.setups.map((setup) => ({
      id: setup.id,
      projectId: setup.projectId,
      hostId: setup.hostId,
      repoId: setup.repoId,
      path: setup.path,
      displayName: setup.displayName,
      setupMethod: setup.setupMethod,
      ...(setup.kind ? { kind: setup.kind } : {}),
      ...(setup.connectionId !== undefined ? { connectionId: setup.connectionId } : {}),
      ...(setup.executionHostId ? { executionHostId: setup.executionHostId } : {})
    })),
    projectOrderBy
  }
}
