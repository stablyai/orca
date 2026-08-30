import type { Project, ProjectHostSetup } from '../../../shared/project-types'
import type { Repo } from '../../../shared/repo-types'
import {
  getProjectIdentityKey,
  type ProjectHostSetupProjection
} from '../../../shared/project-host-setup-projection'

export type NormalizedProjectHostSetupProjection = ProjectHostSetupProjection & {
  changed: boolean
}

export function normalizeHydratedProjectHostSetupProjection(
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
    // Why: hydrated and remote catalog rows can carry a non-string repoId, yet consumers call `.trim()` on it.
    // Why no `changed = true`: that flag unions in repo-derived rows, and coercing one
    // field must never change which rows exist.
    const repoId = typeof setup.repoId === 'string' ? setup.repoId : ''
    const normalizedSetup = repoId === setup.repoId ? setup : { ...setup, repoId }
    // Why the guard: an empty repoId means "no repo attached", so it must match nothing.
    const repo = (repoId ? repoById.get(repoId) : undefined) ?? repoById.get(setup.id)
    if (!repo) {
      return normalizedSetup
    }
    const projectId = getProjectIdentityKey(repo)
    if (projectId === setup.projectId || projectId === `repo:${repo.id}`) {
      return normalizedSetup
    }
    changed = true
    projectIdByHydratedProjectId.set(setup.projectId, projectId)
    return { ...normalizedSetup, projectId }
  })
  const normalizedProjects = projects.flatMap((project) => {
    const projectId = projectIdByHydratedProjectId.get(project.id)
    if (!projectId || projectId === project.id) {
      return [project]
    }
    // Why: runtime-hosted copies of the same Git repo may hydrate path-scoped
    // project ids. If the repo-derived project already exists, keep that bucket
    // authoritative so VM copies group under the user's single project.
    if (derivedProjectIds.has(projectId)) {
      changed = true
      return []
    }
    changed = true
    return [{ ...project, id: projectId }]
  })
  return { projects: normalizedProjects, setups: normalizedSetups, changed }
}
