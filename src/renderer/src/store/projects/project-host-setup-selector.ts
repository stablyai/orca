import type { Project, ProjectHostSetup } from '../../../../shared/project-types'
import {
  projectHostSetupProjectionFromRepos,
  type ProjectHostSetupProjection
} from '../../../../shared/project-host-setup-projection'
import { resolveProjectHostSetupProjection } from '../../../../shared/project-host-setup-hydration'
import type { AppState } from '../types'
import { withAsleepCloudProjectSetups } from './asleep-cloud-project-setups'

const derivedProjectionByRepos = new WeakMap<AppState['repos'], ProjectHostSetupProjection>()
// Catalog writers replace these readonly arrays; their identities are the invalidation boundary.
const resolvedProjectionByCatalog = new WeakMap<
  AppState['repos'],
  WeakMap<readonly Project[], WeakMap<readonly ProjectHostSetup[], ProjectHostSetupProjection>>
>()

function getDerivedProjection(repos: AppState['repos']): ProjectHostSetupProjection {
  const cached = derivedProjectionByRepos.get(repos)
  if (cached) {
    return cached
  }
  const projection = projectHostSetupProjectionFromRepos(repos)
  derivedProjectionByRepos.set(repos, projection)
  return projection
}

// Object.is selector results must be stable per repos/projects/setups identities or every render retriggers.
export function getProjectHostSetupProjectionFromState(
  state: Pick<AppState, 'repos'> &
    Partial<Pick<AppState, 'projects' | 'projectHostSetups' | 'ephemeralVmRuntimesByWorkspaceId'>>
): ProjectHostSetupProjection {
  const { repos, projects, projectHostSetups: catalogSetups } = state
  if (!projects || !catalogSetups) {
    return getDerivedProjection(repos)
  }
  // Asleep Orca Cloud workspaces keep their project until their runtime's catalog loads (RA-9).
  const setups = withAsleepCloudProjectSetups(
    repos,
    projects,
    catalogSetups,
    state.ephemeralVmRuntimesByWorkspaceId
  )
  let byProjects = resolvedProjectionByCatalog.get(repos)
  if (!byProjects) {
    byProjects = new WeakMap()
    resolvedProjectionByCatalog.set(repos, byProjects)
  }
  let bySetups = byProjects.get(projects)
  if (!bySetups) {
    bySetups = new WeakMap()
    byProjects.set(projects, bySetups)
  }
  const cached = bySetups.get(setups)
  if (cached) {
    return cached
  }
  const projection = resolveProjectHostSetupProjection(
    repos,
    projects,
    setups,
    getDerivedProjection(repos)
  )
  bySetups.set(setups, projection)
  return projection
}
