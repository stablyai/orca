import { ORCA_SIDEBAR_INPUTS_IS_MAIN } from '../../../shared/sidebar-inputs-switch'
import type { MainProjectCatalog } from '@/lib/main-project-catalog'
import { projectCatalogAt, type ProjectCatalogVersion } from './project-catalog-version'
import type { AppState } from './types'

// The one read path for the project catalog: repos, project groups, projects and their host setups.
// Switch-off they read today's store fields; switch-on, the main catalog the state's
// projectCatalogVersion names (the window keeps no copy; the store fields stay empty). Readers go
// through here (config/scripts/check-project-catalog-read-ratchet.mjs).

// Store states carry the version even where a reader's type omits it.
type VersionedState = { readonly projectCatalogVersion?: ProjectCatalogVersion }

function mainCatalogOf(state: VersionedState): MainProjectCatalog {
  return projectCatalogAt(state.projectCatalogVersion)
}

export function selectRepos(state: Pick<AppState, 'repos'>): AppState['repos']
/** A reader typed on a narrower state shape; switch-on it reads main's rows too. */
export function selectRepos<State extends { readonly repos?: unknown }>(
  state: State
): State['repos'] | AppState['repos']
export function selectRepos(state: { readonly repos?: unknown } & VersionedState): unknown {
  return ORCA_SIDEBAR_INPUTS_IS_MAIN ? mainCatalogOf(state).repos : state.repos
}

export function selectProjectGroups(
  state: Pick<AppState, 'projectGroups'>
): AppState['projectGroups']
export function selectProjectGroups<State extends { readonly projectGroups?: unknown }>(
  state: State
): State['projectGroups'] | AppState['projectGroups']
export function selectProjectGroups(
  state: { readonly projectGroups?: unknown } & VersionedState
): unknown {
  return ORCA_SIDEBAR_INPUTS_IS_MAIN ? mainCatalogOf(state).projectGroups : state.projectGroups
}

export function selectProjects(state: Pick<AppState, 'projects'>): AppState['projects']
export function selectProjects<State extends { readonly projects?: unknown }>(
  state: State
): State['projects'] | AppState['projects']
export function selectProjects(state: { readonly projects?: unknown } & VersionedState): unknown {
  return ORCA_SIDEBAR_INPUTS_IS_MAIN ? mainCatalogOf(state).projects : state.projects
}

export function selectProjectHostSetups(
  state: Pick<AppState, 'projectHostSetups'>
): AppState['projectHostSetups']
export function selectProjectHostSetups<State extends { readonly projectHostSetups?: unknown }>(
  state: State
): State['projectHostSetups'] | AppState['projectHostSetups']
export function selectProjectHostSetups(
  state: { readonly projectHostSetups?: unknown } & VersionedState
): unknown {
  return ORCA_SIDEBAR_INPUTS_IS_MAIN
    ? mainCatalogOf(state).projectHostSetups
    : state.projectHostSetups
}

/** The whole catalog a state reads, for a reader outside the store (e2e builds expose it). */
export function selectProjectCatalog(
  state: Pick<AppState, 'repos' | 'projectGroups' | 'projects' | 'projectHostSetups'>
): Pick<AppState, 'repos' | 'projectGroups' | 'projects' | 'projectHostSetups'> {
  return {
    repos: selectRepos(state),
    projectGroups: selectProjectGroups(state),
    projects: selectProjects(state),
    projectHostSetups: selectProjectHostSetups(state)
  }
}
