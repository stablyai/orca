import { isIncognitoRepo, withoutIncognitoRepos } from './incognito-projects'
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

/** Projects whose every setup and source repo is incognito: their names would name the hidden repo. */
function incognitoOnlyProjectIds(
  projection: ProjectHostSetupProjection,
  incognitoRepoIds: ReadonlySet<string>
): Set<string> {
  const projectIds = new Set<string>()
  const visibleProjectIds = new Set<string>()
  const classify = (projectId: string, repoId: string): void => {
    if (incognitoRepoIds.has(repoId)) {
      projectIds.add(projectId)
    } else {
      visibleProjectIds.add(projectId)
    }
  }
  for (const setup of projection.setups) {
    classify(setup.projectId, setup.repoId)
  }
  for (const project of projection.projects) {
    for (const repoId of project.sourceRepoIds) {
      classify(project.id, repoId)
    }
  }
  for (const projectId of visibleProjectIds) {
    projectIds.delete(projectId)
  }
  return projectIds
}

/**
 * The sidebar's repos, in its order, and the projection its project-header selector produced.
 * Why incognito repos are dropped: phones have no incognito unlock, so their names never cross.
 */
export function buildMobileProjectSectionCatalog(
  allRepos: readonly Repo[],
  projection: ProjectHostSetupProjection,
  projectOrderBy: ProjectOrderBy
): MobileProjectSectionCatalog {
  const incognitoRepoIds = new Set(allRepos.filter(isIncognitoRepo).map((repo) => repo.id))
  const repos = withoutIncognitoRepos(allRepos)
  const hiddenProjectIds = incognitoOnlyProjectIds(projection, incognitoRepoIds)
  const setups = projection.setups.filter((setup) => !incognitoRepoIds.has(setup.repoId))
  const projects = projection.projects.filter((project) => !hiddenProjectIds.has(project.id))
  return {
    repos: repos.map(sectionRepo),
    projects: projects.map(({ id, displayName }) => ({ id, displayName })),
    setups: setups.map((setup) => ({
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
