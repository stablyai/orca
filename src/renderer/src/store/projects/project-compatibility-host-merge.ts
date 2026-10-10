import type { Project, ProjectHostSetup } from '../../../../shared/project-types'
import type { Repo } from '../../../../shared/repo-types'
import { reconcileCatalogRows } from '../slices/repo-identity-reconcile'
import {
  getRepoExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId
} from '../../../../shared/execution-host'
import type { RepoSlice } from '../repos/repo-state'
import {
  getProjectHostSetupOwnerKey,
  getReposById,
  getSourceRepoIdsOutsideHost,
  mergePreviousProjectMetadata,
  mergeProjectCompatibilityProjects,
  mergeProjectHostSetupsByOwner,
  projectWithCurrentSourceRepoIds
} from './project-compatibility-core'

export function getProjectHostIds(
  project: Project,
  setups: readonly ProjectHostSetup[],
  repos: readonly Repo[]
): Set<string> {
  const hostIds = getExplicitProjectHostIds(project, setups, repos)
  if (hostIds.size === 0) {
    hostIds.add(LOCAL_EXECUTION_HOST_ID)
  }
  return hostIds
}

export function getExplicitProjectHostIds(
  project: Project,
  setups: readonly ProjectHostSetup[],
  repos: readonly Repo[]
): Set<string> {
  const hostIds = new Set<string>()
  const sourceRepoIds = new Set(project.sourceRepoIds)
  for (const setup of setups) {
    if (setup.projectId === project.id) {
      hostIds.add(setup.hostId)
    }
  }
  for (const repo of repos) {
    if (sourceRepoIds.has(repo.id)) {
      hostIds.add(getRepoExecutionHostId(repo))
    }
  }
  return hostIds
}

export function indexProjectHostSetupsByProjectId(
  setups: readonly ProjectHostSetup[]
): Map<string, ProjectHostSetup[]> {
  const setupsByProjectId = new Map<string, ProjectHostSetup[]>()
  for (const setup of setups) {
    const existing = setupsByProjectId.get(setup.projectId)
    if (existing) {
      existing.push(setup)
    } else {
      setupsByProjectId.set(setup.projectId, [setup])
    }
  }
  return setupsByProjectId
}

export function getProjectSourceRepos(
  project: Project,
  reposById: ReadonlyMap<string, readonly Repo[]>
): Repo[] {
  const sourceRepos: Repo[] = []
  for (const repoId of project.sourceRepoIds) {
    for (const repo of reposById.get(repoId) ?? []) {
      sourceRepos.push(repo)
    }
  }
  return sourceRepos
}

// Why: the host-id resolvers rescan every setup and repo per project; feeding them the project's own slices keeps a catalog refresh linear.
export function createProjectHostIdIndex(
  setups: readonly ProjectHostSetup[],
  reposById: ReadonlyMap<string, readonly Repo[]>,
  resolveHostIds: (
    project: Project,
    setups: readonly ProjectHostSetup[],
    repos: readonly Repo[]
  ) => Set<string>
): (project: Project) => ReadonlySet<string> {
  const noSetups: readonly ProjectHostSetup[] = []
  const hostIdsByProject = new Map<Project, ReadonlySet<string>>()
  let setupsByProjectId: Map<string, ProjectHostSetup[]> | null = null
  return (project) => {
    const cached = hostIdsByProject.get(project)
    if (cached) {
      return cached
    }
    setupsByProjectId ??= indexProjectHostSetupsByProjectId(setups)
    const hostIds = resolveHostIds(
      project,
      setupsByProjectId.get(project.id) ?? noSetups,
      getProjectSourceRepos(project, reposById)
    )
    hostIdsByProject.set(project, hostIds)
    return hostIds
  }
}

// Why: mergePreviousProjectMetadata scans the whole catalog's repo key set; a view holding only this pair's repos keeps that scan per-project.
export function restrictReposToProjectPair(
  previous: Project,
  current: Project,
  reposById: ReadonlyMap<string, readonly Repo[]>
): Map<string, readonly Repo[]> {
  const restricted = new Map<string, readonly Repo[]>()
  for (const project of [previous, current]) {
    for (const repoId of project.sourceRepoIds) {
      const matches = reposById.get(repoId)
      if (matches) {
        restricted.set(repoId, matches)
      }
    }
  }
  return restricted
}

export function mergeFetchedProjectCompatibilityForHost({
  previous,
  fetched,
  repos,
  hostId
}: {
  previous: Pick<RepoSlice, 'projects' | 'projectHostSetups'>
  fetched: Pick<RepoSlice, 'projects' | 'projectHostSetups'>
  repos: readonly Repo[]
  hostId: string
}): Pick<RepoSlice, 'projects' | 'projectHostSetups'> {
  const setupBelongsToFetchedCatalog = (setup: ProjectHostSetup): boolean => {
    if (hostId !== LOCAL_EXECUTION_HOST_ID) {
      return setup.hostId === hostId
    }
    const owner = parseExecutionHostId(setup.hostId)
    // Why: desktop persistence owns local and direct-SSH setups; runtime setups stay authoritative on their remote Orca server.
    return setup.hostId === LOCAL_EXECUTION_HOST_ID || owner?.kind === 'ssh'
  }
  const fetchedSetupsForHost = fetched.projectHostSetups.filter(setupBelongsToFetchedCatalog)
  const preservedSetups = previous.projectHostSetups.filter(
    (setup) => !setupBelongsToFetchedCatalog(setup)
  )
  const projectHostSetups = mergeProjectHostSetupsByOwner(preservedSetups, fetchedSetupsForHost)
  const previousProjectById = new Map(previous.projects.map((project) => [project.id, project]))
  const reposById = getReposById(repos)
  const currentRepoIds = new Set(repos.map((repo) => repo.id))
  const fetchedProjectHostIds = createProjectHostIdIndex(
    fetched.projectHostSetups,
    reposById,
    getProjectHostIds
  )
  const previousProjectHostIds = createProjectHostIdIndex(
    previous.projectHostSetups,
    reposById,
    getProjectHostIds
  )
  const currentProjectOwnerHostIds = createProjectHostIdIndex(
    projectHostSetups,
    reposById,
    getExplicitProjectHostIds
  )
  const projectHasCurrentOwnerOutsideHost = (project: Project): boolean => {
    for (const ownerHostId of currentProjectOwnerHostIds(project)) {
      if (ownerHostId !== hostId) {
        return true
      }
    }
    return false
  }
  const fetchedProjects = fetched.projects
    .filter((project) => {
      const previousProject = previousProjectById.get(project.id)
      // Why: repo-derived compatibility projects include every host; a one-host refresh should only reconcile or prune that host's ownership.
      return (
        fetchedProjectHostIds(project).has(hostId) ||
        (previousProject ? previousProjectHostIds(previousProject).has(hostId) : false)
      )
    })
    .map((project) => {
      const previousProject = previousProjectById.get(project.id)
      return previousProject
        ? mergePreviousProjectMetadata(
            previousProject,
            project,
            restrictReposToProjectPair(previousProject, project, reposById),
            hostId
          )
        : projectWithCurrentSourceRepoIds(project, currentRepoIds)
    })
  const fetchedProjectIds = new Set(fetchedProjects.map((project) => project.id))
  const preservedProjects = previous.projects.filter(
    (project) =>
      !fetchedProjectIds.has(project.id) &&
      (!previousProjectHostIds(project).has(hostId) || projectHasCurrentOwnerOutsideHost(project))
  )
  // Why: both merges always allocate (sourceRepoIds is rebuilt per project, and fetched setups
  // arrive freshly cloned over IPC), so reconcile against `previous` to recover identity when a
  // refresh changed nothing. Each key is what the producing merge already dedups by.
  return {
    projects: reconcileCatalogRows(
      previous.projects,
      mergeProjectCompatibilityProjects(
        preservedProjects.map((project) => {
          const sourceRepoIds = getSourceRepoIdsOutsideHost(project, reposById, hostId)
          return sourceRepoIds.length === project.sourceRepoIds.length
            ? project
            : { ...project, sourceRepoIds }
        }),
        fetchedProjects
      ),
      (project) => project.id
    ),
    projectHostSetups: reconcileCatalogRows(
      previous.projectHostSetups,
      projectHostSetups,
      getProjectHostSetupOwnerKey
    )
  }
}
