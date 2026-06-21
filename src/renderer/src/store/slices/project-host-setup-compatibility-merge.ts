import type { ProjectHostSetupProjection } from '../../../../shared/project-host-setup-projection'
import { projectHostSetupProjectionFromRepos } from '../../../../shared/project-host-setup-projection'
import type { Project, ProjectHostSetup, Repo } from '../../../../shared/types'

export type ProjectHostSetupCompatibility = {
  projects: Project[]
  projectHostSetups: ProjectHostSetup[]
}

export function projectCompatibilityFromRepos(
  repos: readonly Repo[]
): ProjectHostSetupCompatibility {
  const projection = projectHostSetupProjectionFromRepos(repos)
  return {
    projects: projection.projects,
    projectHostSetups: projection.setups
  }
}

export function mergeProjectHostSetupCompatibility(
  derived: ProjectHostSetupCompatibility,
  fetched: ProjectHostSetupProjection
): ProjectHostSetupCompatibility {
  const fetchedSetupOwners = new Set(fetched.setups.map(getProjectHostSetupOwnerKey))
  const derivedSetups = derived.projectHostSetups.filter(
    (setup) => !fetchedSetupOwners.has(getProjectHostSetupOwnerKey(setup))
  )
  const projectHostSetups = mergeByKey(
    derivedSetups,
    fetched.setups,
    getProjectHostSetupOwnerKey,
    (_base, overlay) => overlay
  )
  const setupProjectIds = new Set(projectHostSetups.map((setup) => setup.projectId))
  const fetchedProjectIds = new Set(fetched.projects.map((project) => project.id))
  return {
    projects: mergeByKey(
      derived.projects,
      fetched.projects,
      (project) => project.id,
      mergeProject
    ).filter((project) => fetchedProjectIds.has(project.id) || setupProjectIds.has(project.id)),
    projectHostSetups
  }
}

function getProjectHostSetupOwnerKey(setup: ProjectHostSetup): string {
  // Why: setup ids can come from per-host repo ids. Host + repo is the durable
  // ownership boundary when one project is checked out on multiple servers.
  return `${setup.hostId}:${setup.repoId ?? setup.id}`
}

function mergeProject(base: Project, overlay: Project): Project {
  return {
    ...base,
    ...overlay,
    // Why: a one-host refresh may fetch a project row that only lists that
    // host's checkout; keep the other host setups attached to the project.
    sourceRepoIds: [...new Set([...base.sourceRepoIds, ...overlay.sourceRepoIds])]
  }
}

function mergeByKey<T>(
  base: readonly T[],
  overlay: readonly T[],
  getKey: (entry: T) => string,
  mergeEntry: (base: T, overlay: T) => T
): T[] {
  const merged = [...base]
  const indexByKey = new Map(merged.map((entry, index) => [getKey(entry), index]))
  for (const entry of overlay) {
    const key = getKey(entry)
    const index = indexByKey.get(key)
    if (index === undefined) {
      indexByKey.set(key, merged.length)
      merged.push(entry)
    } else {
      merged[index] = mergeEntry(merged[index], entry)
    }
  }
  return merged
}
