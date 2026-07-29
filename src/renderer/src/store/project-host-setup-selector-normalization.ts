import type { Project, ProjectHostSetup, Repo } from '../../../shared/types'
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
