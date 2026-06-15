import { projectHostSetupProjectionFromRepos } from '../../../shared/project-host-setup-projection'
import type { Project, ProjectHostSetup, Repo } from '../../../shared/types'

export type NewWorkspaceProjectOption = {
  id: string
  displayName: string
  badgeColor: string
  detail: string
}

type BuildNewWorkspaceProjectOptionsInput = {
  projects: readonly Project[]
  projectHostSetups: readonly ProjectHostSetup[]
  eligibleRepos: readonly Repo[]
}

function getProjectModel({
  projects,
  projectHostSetups,
  eligibleRepos
}: BuildNewWorkspaceProjectOptionsInput): {
  projects: readonly Project[]
  projectHostSetups: readonly ProjectHostSetup[]
} {
  if (projects.length > 0 || projectHostSetups.length > 0) {
    return { projects, projectHostSetups }
  }
  const projection = projectHostSetupProjectionFromRepos(eligibleRepos)
  return {
    projects: projection.projects,
    projectHostSetups: projection.setups
  }
}

function getProjectDetail(project: Project, readySetupCount: number): string {
  if (project.providerIdentity) {
    return `${project.providerIdentity.owner}/${project.providerIdentity.repo}`
  }
  if (readySetupCount > 1) {
    return `${readySetupCount} hosts configured`
  }
  return 'Project'
}

export function buildNewWorkspaceProjectOptions(
  input: BuildNewWorkspaceProjectOptionsInput
): NewWorkspaceProjectOption[] {
  const { eligibleRepos } = input
  const { projects, projectHostSetups } = getProjectModel(input)
  const eligibleRepoIds = new Set(eligibleRepos.map((repo) => repo.id))
  const readySetupCountsByProjectId = new Map<string, number>()

  for (const setup of projectHostSetups) {
    if (setup.setupState !== 'ready' || !eligibleRepoIds.has(setup.repoId)) {
      continue
    }
    readySetupCountsByProjectId.set(
      setup.projectId,
      (readySetupCountsByProjectId.get(setup.projectId) ?? 0) + 1
    )
  }

  return projects
    .filter((project) => (readySetupCountsByProjectId.get(project.id) ?? 0) > 0)
    .map((project) => ({
      id: project.id,
      displayName: project.displayName,
      badgeColor: project.badgeColor,
      detail: getProjectDetail(project, readySetupCountsByProjectId.get(project.id) ?? 0)
    }))
    .sort((a, b) => a.displayName.localeCompare(b.displayName) || a.detail.localeCompare(b.detail))
}

export function searchNewWorkspaceProjectOptions(
  options: readonly NewWorkspaceProjectOption[],
  rawQuery: string
): NewWorkspaceProjectOption[] {
  const query = rawQuery.trim().toLowerCase()
  if (!query) {
    return [...options]
  }
  return options.filter((option) =>
    [option.displayName, option.detail].some((value) => value.toLowerCase().includes(query))
  )
}
