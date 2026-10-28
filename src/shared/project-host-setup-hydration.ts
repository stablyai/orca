import type { Project, ProjectHostSetup } from './project-types'
import type { Repo } from './repo-types'
import {
  getProjectIdentityKey,
  projectHostSetupProjectionFromRepos,
  type ProjectHostSetupProjection
} from './project-host-setup-projection'

type NormalizedProjectHostSetupProjection = ProjectHostSetupProjection & {
  changed: boolean
}

function normalizeHydratedProjectHostSetupProjection(
  repos: readonly Repo[],
  projects: readonly Project[],
  setups: readonly ProjectHostSetup[],
  derived: ProjectHostSetupProjection
): NormalizedProjectHostSetupProjection {
  const repoById = new Map(repos.map((repo) => [repo.id, repo]))
  const derivedProjectIds = new Set(derived.projects.map((project) => project.id))
  const projectIdByHydratedProjectId = new Map<string, string>()
  let changed = false
  const normalizedSetups = setups.map((setup) => {
    const repo = repoById.get(setup.repoId) ?? repoById.get(setup.id)
    if (!repo) {
      return setup
    }
    const projectId = getProjectIdentityKey(repo)
    if (projectId === setup.projectId || projectId === `repo:${repo.id}`) {
      return setup
    }
    changed = true
    projectIdByHydratedProjectId.set(setup.projectId, projectId)
    return { ...setup, projectId }
  })
  const normalizedProjects = projects.flatMap((project) => {
    const projectId = projectIdByHydratedProjectId.get(project.id)
    if (!projectId || projectId === project.id) {
      return [project]
    }
    // Runtime copies may use path-scoped IDs; retain repo-derived canonical projects so VM copies share the user’s bucket.
    if (derivedProjectIds.has(projectId)) {
      changed = true
      return []
    }
    changed = true
    return [{ ...project, id: projectId }]
  })
  return { projects: normalizedProjects, setups: normalizedSetups, changed }
}

/** `overlay` rows replace `base` rows of the same id; new ids append in overlay order. */
function mergeProjectionRowsById<T extends { id: string }>(
  base: readonly T[],
  overlay: readonly T[]
): T[] {
  const merged = [...base]
  const indexById = new Map(merged.map((entry, index) => [entry.id, index]))
  for (const entry of overlay) {
    const index = indexById.get(entry.id)
    if (index === undefined) {
      indexById.set(entry.id, merged.length)
      merged.push(entry)
    } else {
      merged[index] = entry
    }
  }
  return merged
}

/** Whether some repo has no host setup naming it, by setup repo id or setup id. */
function hasReposWithoutProjectHostSetup(
  repos: readonly Pick<Repo, 'id'>[],
  setups: readonly ProjectHostSetup[]
): boolean {
  const repoIds = new Set(repos.map((repo) => repo.id))
  const coveredRepoIds = new Set<string>()
  for (const setup of setups) {
    const repoId = typeof setup.repoId === 'string' ? setup.repoId : ''
    if (repoIds.has(repoId)) {
      coveredRepoIds.add(repoId)
    }
    if (repoIds.has(setup.id)) {
      coveredRepoIds.add(setup.id)
    }
  }
  return repos.length > 0 && coveredRepoIds.size < repoIds.size
}

/** The repo-derived rows overlaid with the hydrated ones, so a repo without a setup still groups. */
function mergeDerivedProjectHostSetupProjection(
  derived: ProjectHostSetupProjection,
  normalized: ProjectHostSetupProjection
): ProjectHostSetupProjection {
  return {
    projects: mergeProjectionRowsById(derived.projects, normalized.projects),
    setups: mergeProjectionRowsById(derived.setups, normalized.setups)
  }
}

/** Normalize hydrated IDs onto repos and fill missing setups with repo-derived rows; the renderer selector memoizes this projection. */
export function resolveProjectHostSetupProjection(
  repos: readonly Repo[],
  projects: readonly Project[],
  setups: readonly ProjectHostSetup[],
  derived: ProjectHostSetupProjection = projectHostSetupProjectionFromRepos(repos)
): ProjectHostSetupProjection {
  const normalized = normalizeHydratedProjectHostSetupProjection(repos, projects, setups, derived)
  // Older runtimes/profiles may provide partial/empty project rows beside repos; keep repo-backed fallbacks visible.
  return hasReposWithoutProjectHostSetup(repos, setups) || normalized.changed
    ? mergeDerivedProjectHostSetupProjection(derived, normalized)
    : { projects, setups }
}
