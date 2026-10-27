import type { Project, ProjectHostSetup } from './project-types'
import type { Repo } from './repo-types'
import { getProjectHostSetupLookup } from './project-host-setup-lookup'
import {
  getRepoDerivedSetupKey,
  mergeProjectHostSetupCompatibility
} from './project-compatibility-merge'
import {
  projectHostSetupProjectionFromRepos,
  type ProjectHostSetupProjection
} from './project-host-setup-projection'

/** Canonical client affiliation; the supplied endpoint catalog remains untouched. */
export function resolveProjectHostSetupProjection(
  repos: readonly Repo[],
  projects: readonly Project[],
  setups: readonly ProjectHostSetup[],
  derived: ProjectHostSetupProjection = projectHostSetupProjectionFromRepos(repos)
): ProjectHostSetupProjection {
  if (setups.some((setup) => setup.setupMethod === 'provisioned' && setup.repoId)) {
    derived = projectHostSetupProjectionFromRepos(repos, undefined, setups)
  }
  const owners = getProjectHostSetupLookup(derived.setups)
  const projectById = new Map(projects.map((project) => [project.id, project]))
  const replacedProjectIds = new Set<string>()
  const unresolved = new Set(
    derived.projects.flatMap((project) =>
      project.providerIdentity || project.gitRemoteIdentity ? [] : [project.id]
    )
  )
  const metadataByProject = new Map<string, Project>()
  const normalizedSetups = setups.map((setup) => {
    const projectId = owners.projectId({
      repoId: setup.repoId,
      hostId: setup.executionHostId ?? setup.hostId,
      runtimeOwnerEnvironmentId: setup.runtimeOwnerEnvironmentId
    })
    if (!projectId || unresolved.has(projectId)) {
      return setup
    }
    const metadata = projectById.get(setup.projectId)
    if (metadata && !metadataByProject.has(projectId)) {
      metadataByProject.set(projectId, metadata)
    }
    if (projectId === setup.projectId) {
      return setup
    }
    replacedProjectIds.add(setup.projectId)
    return { ...setup, projectId }
  })
  const covered = new Set(setups.map(getRepoDerivedSetupKey))
  if (
    replacedProjectIds.size === 0 &&
    derived.setups.every((setup) => covered.has(getRepoDerivedSetupKey(setup)))
  ) {
    return { projects, setups }
  }
  const allSetups = mergeProjectHostSetupCompatibility(
    { projects: derived.projects, projectHostSetups: derived.setups },
    { projects, setups: normalizedSetups }
  ).projectHostSetups
  const membership = new Map<string, Set<string>>()
  for (const setup of allSetups) {
    const ids = membership.get(setup.projectId) ?? new Set<string>()
    if (setup.repoId) {
      ids.add(setup.repoId)
    }
    membership.set(setup.projectId, ids)
  }
  const canonicalProjects = derived.projects
    .filter((project) => membership.has(project.id))
    .map((project) => ({
      ...project,
      ...metadataByProject.get(project.id),
      id: project.id,
      displayName: project.displayName,
      badgeColor: project.badgeColor,
      sourceRepoIds: [...(membership.get(project.id) ?? [])]
    }))
  const canonicalIds = new Set(canonicalProjects.map((project) => project.id))
  return {
    projects: [
      ...canonicalProjects,
      ...projects.filter(
        (project) =>
          !canonicalIds.has(project.id) &&
          (!replacedProjectIds.has(project.id) || membership.has(project.id))
      )
    ],
    setups: allSetups
  }
}
