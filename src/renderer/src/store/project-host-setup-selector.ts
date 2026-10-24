import type { Project, ProjectHostSetup } from '../../../shared/project-types'
import {
  projectHostSetupProjectionFromRepos,
  type ProjectHostSetupProjection
} from '../../../shared/project-host-setup-projection'
import { resolveProjectHostSetupProjection } from '../../../shared/project-catalog-canonical-projection'
import { resolveProjectHostSetupProjection as resolveCompatibility } from '../../../shared/project-host-setup-hydration'
import type { AppState } from './types'

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

export type ProjectCatalogReadState = Pick<AppState, 'repos'> &
  (
    | { projectHostSetupProjection: ProjectHostSetupProjection }
    | Pick<AppState, 'endpointProjects' | 'endpointProjectHostSetups'>
  )

// Why: this is a zustand selector compared with Object.is, so the result must be
// reference-stable per (repos, projects, setups) input or every render re-renders.
export function getProjectHostSetupProjectionFromState(
  state: ProjectCatalogReadState
): ProjectHostSetupProjection {
  if ('projectHostSetupProjection' in state) {
    return state.projectHostSetupProjection
  }
  const { repos, endpointProjects: projects, endpointProjectHostSetups: setups } = state
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

export const selectCanonicalProjects = (
  state: Parameters<typeof getProjectHostSetupProjectionFromState>[0]
) => getProjectHostSetupProjectionFromState(state).projects

export const selectCanonicalProjectHostSetups = (
  state: Parameters<typeof getProjectHostSetupProjectionFromState>[0]
) => getProjectHostSetupProjectionFromState(state).setups

const compatibilityByCanonical = new WeakMap<
  ProjectHostSetupProjection,
  ProjectHostSetupProjection
>()
export function getProjectHostSetupCompatibilityFromState(
  state: Pick<AppState, 'repos' | 'endpointProjects' | 'endpointProjectHostSetups'>
): ProjectHostSetupProjection {
  const canonical = getProjectHostSetupProjectionFromState({
    repos: state.repos,
    endpointProjects: state.endpointProjects,
    endpointProjectHostSetups: state.endpointProjectHostSetups
  })
  let compatibility = compatibilityByCanonical.get(canonical)
  if (!compatibility) {
    compatibility = resolveCompatibility(
      state.repos,
      state.endpointProjects,
      state.endpointProjectHostSetups
    )
    compatibilityByCanonical.set(canonical, compatibility)
  }
  return compatibility
}
