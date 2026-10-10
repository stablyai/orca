import type { Project, ProjectHostSetup } from '../../../../shared/project-types'
import type { Repo } from '../../../../shared/repo-types'
import {
  mergeCatalogCreatedAt,
  mergeCatalogUpdatedAt,
  projectHostSetupProjectionFromRepos
} from '../../../../shared/project-host-setup-projection'
import type { ProjectHostSetupProjection } from '../../../../shared/project-host-setup-projection'
import { getRepoExecutionHostId, LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import type { ProjectUpdate, RepoSlice } from '../repos/repo-state'

export function projectCompatibilityFromRepos(
  repos: readonly Repo[]
): Pick<RepoSlice, 'projects' | 'projectHostSetups'> {
  const projection = projectHostSetupProjectionFromRepos(repos)
  return {
    projects: projection.projects,
    projectHostSetups: projection.setups
  }
}

export function mergeProjectCompatibilityProject(base: Project, overlay: Project): Project {
  const localWindowsRuntimePreference =
    'localWindowsRuntimePreference' in overlay
      ? overlay.localWindowsRuntimePreference
      : base.localWindowsRuntimePreference
  const project: Project = {
    ...base,
    ...overlay,
    // Why: all-host startup fetches hosts separately; one host's record must not erase repo ownership learned from another host with the same id.
    sourceRepoIds: [...new Set([...base.sourceRepoIds, ...overlay.sourceRepoIds])],
    // Why not plain min/max: a host whose repos carry no `addedAt` projects 0, and 0 means
    // unknown, not epoch — it must not win over the real timestamp the other host knows.
    createdAt: mergeCatalogCreatedAt(base.createdAt, overlay.createdAt),
    updatedAt: mergeCatalogUpdatedAt(base.updatedAt, overlay.updatedAt)
  }
  if (localWindowsRuntimePreference === undefined) {
    delete project.localWindowsRuntimePreference
  } else {
    project.localWindowsRuntimePreference = localWindowsRuntimePreference
  }
  return project
}

export function mergeProjectCompatibilityProjects(
  base: readonly Project[],
  overlay: readonly Project[]
): Project[] {
  const merged = [...base]
  const indexById = new Map(merged.map((entry, index) => [entry.id, index]))
  for (const entry of overlay) {
    const index = indexById.get(entry.id)
    if (index === undefined) {
      indexById.set(entry.id, merged.length)
      merged.push(entry)
    } else {
      merged[index] = mergeProjectCompatibilityProject(merged[index]!, entry)
    }
  }
  return merged
}

export function mergeUpdatedProjectCompatibilityProject(
  base: Project,
  updated: Project,
  updates: ProjectUpdate
): Project {
  const project = mergeProjectCompatibilityProject(base, updated)
  if ('localWindowsRuntimePreference' in updates) {
    const localWindowsRuntimePreference =
      'localWindowsRuntimePreference' in updated
        ? updated.localWindowsRuntimePreference
        : updates.localWindowsRuntimePreference
    // Why: project.update returns one host's record, but preference clears must override the cross-host metadata-preservation merge.
    if (localWindowsRuntimePreference === undefined) {
      delete project.localWindowsRuntimePreference
    } else {
      project.localWindowsRuntimePreference = localWindowsRuntimePreference
    }
  }
  return project
}

export function getCurrentSourceRepoIds(
  project: Project,
  currentRepoIds: ReadonlySet<string>
): string[] {
  return project.sourceRepoIds.filter((repoId) => currentRepoIds.has(repoId))
}

export function getReposById(repos: readonly Repo[]): Map<string, Repo[]> {
  const reposById = new Map<string, Repo[]>()
  for (const repo of repos) {
    const existing = reposById.get(repo.id)
    if (existing) {
      existing.push(repo)
    } else {
      reposById.set(repo.id, [repo])
    }
  }
  return reposById
}

export function getSourceRepoIdsOutsideHost(
  project: Project,
  reposById: ReadonlyMap<string, readonly Repo[]>,
  hostId: string
): string[] {
  return project.sourceRepoIds.filter((repoId) => {
    const repos = reposById.get(repoId) ?? []
    return repos.some((repo) => getRepoExecutionHostId(repo) !== hostId)
  })
}

export function getMergedSourceRepoIdsForHostRefresh(
  previous: Project,
  current: Project,
  reposById: ReadonlyMap<string, readonly Repo[]>,
  hostId: string
): string[] {
  // Why: current-first keeps the order independent of which host refreshed. Prefixing the
  // cross-host remainder made it a function of hostId, so a cross-host project's ids oscillated
  // between refreshes and the projects reconcile could never reuse the row.
  return [
    ...new Set([
      ...getCurrentSourceRepoIds(current, new Set(reposById.keys())),
      ...getSourceRepoIdsOutsideHost(previous, reposById, hostId)
    ])
  ]
}

export function projectWithCurrentSourceRepoIds(
  project: Project,
  currentRepoIds: ReadonlySet<string>
): Project {
  const sourceRepoIds = getCurrentSourceRepoIds(project, currentRepoIds)
  return sourceRepoIds.length === project.sourceRepoIds.length
    ? project
    : { ...project, sourceRepoIds }
}

export function getLocalHostRepoBadgeColor(
  project: Project,
  reposById: ReadonlyMap<string, readonly Repo[]>
): string | null {
  for (const repoId of project.sourceRepoIds) {
    for (const repo of reposById.get(repoId) ?? []) {
      if (getRepoExecutionHostId(repo) === LOCAL_EXECUTION_HOST_ID) {
        return repo.badgeColor
      }
    }
  }
  return null
}

export function mergePreviousProjectMetadata(
  previous: Project,
  current: Project,
  reposById: ReadonlyMap<string, readonly Repo[]>,
  hostId: string
): Project {
  const project = mergeProjectCompatibilityProject(previous, current)
  const sourceRepoIds = getMergedSourceRepoIdsForHostRefresh(previous, current, reposById, hostId)
  const localBadgeColor = getLocalHostRepoBadgeColor({ ...project, sourceRepoIds }, reposById)
  if (localBadgeColor !== null) {
    // Why: badge color is per-host repo metadata; a remote host sharing the project must not repaint the color the user chose locally.
    project.badgeColor = localBadgeColor
  }
  if (hostId === LOCAL_EXECUTION_HOST_ID) {
    // Why: localWindowsRuntimePreference belongs to the local host; a local refresh that omits it is authoritative and clears stale renderer state.
    if ('localWindowsRuntimePreference' in current) {
      if (current.localWindowsRuntimePreference === undefined) {
        delete project.localWindowsRuntimePreference
      } else {
        project.localWindowsRuntimePreference = current.localWindowsRuntimePreference
      }
    } else {
      delete project.localWindowsRuntimePreference
    }
  } else if (previous.localWindowsRuntimePreference !== undefined) {
    // Why: a remote runtime's local Windows preference must not overwrite the client-local project runtime setting.
    project.localWindowsRuntimePreference = previous.localWindowsRuntimePreference
  }
  return {
    ...project,
    // Why: fetched project metadata can lag repo.list; track ownership to the reconciled repos so removed-host repos don't linger.
    sourceRepoIds
  }
}

export function mergeProjectHostSetupCompatibility(
  derived: Pick<RepoSlice, 'projects' | 'projectHostSetups'>,
  fetched: ProjectHostSetupProjection
): Pick<RepoSlice, 'projects' | 'projectHostSetups'> {
  const fetchedRepoSetupKeys = new Set(fetched.setups.map(getRepoDerivedSetupKey))
  const derivedSetups = derived.projectHostSetups.filter(
    (setup) => !fetchedRepoSetupKeys.has(getRepoDerivedSetupKey(setup))
  )
  const projectHostSetups = mergeProjectHostSetupsByOwner(derivedSetups, fetched.setups)
  const setupProjectIds = new Set(projectHostSetups.map((setup) => setup.projectId))
  const fetchedProjectIds = new Set(fetched.projects.map((project) => project.id))
  return {
    projects: mergeProjectCompatibilityProjects(derived.projects, fetched.projects).filter(
      (project) => fetchedProjectIds.has(project.id) || setupProjectIds.has(project.id)
    ),
    projectHostSetups
  }
}

export function getRepoDerivedSetupKey(setup: ProjectHostSetup): string {
  // Why: authoritative routing provenance may be absent from the repo-derived fallback it replaces.
  return JSON.stringify([setup.hostId, setup.repoId || setup.id])
}

export function getProjectHostSetupOwnerKey(setup: ProjectHostSetup): string {
  return JSON.stringify([
    setup.hostId,
    setup.executionHostId ?? setup.hostId,
    setup.runtimeOwnerEnvironmentId ?? null,
    setup.repoId || setup.id
  ])
}

export function mergeProjectHostSetupsByOwner(
  base: readonly ProjectHostSetup[],
  overlay: readonly ProjectHostSetup[]
): ProjectHostSetup[] {
  const merged = [...base]
  const indexByOwner = new Map(
    merged.map((entry, index) => [getProjectHostSetupOwnerKey(entry), index])
  )
  for (const entry of overlay) {
    const index = indexByOwner.get(getProjectHostSetupOwnerKey(entry))
    if (index === undefined) {
      indexByOwner.set(getProjectHostSetupOwnerKey(entry), merged.length)
      merged.push(entry)
    } else {
      merged[index] = entry
    }
  }
  return merged
}
