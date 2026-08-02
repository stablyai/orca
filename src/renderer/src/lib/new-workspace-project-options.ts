import { projectHostSetupProjectionFromRepos } from '../../../shared/project-host-setup-projection'
import type { Project, ProjectGroup, ProjectHostSetup, Repo } from '../../../shared/types'
import { isClipboardTextByteLengthOverLimit } from '../../../shared/clipboard-text'
import type { ExecutionHostRegistryEntry } from '../../../shared/execution-host-registry'
import {
  getDuplicateProjectDetailsById,
  type ProjectSetupDirectory
} from './new-workspace-duplicate-project-details'

export const NEW_WORKSPACE_PROJECT_GROUP_OPTION_PREFIX = 'project-group:'
export const NEW_WORKSPACE_FOLDER_SOURCE_OPTION_PREFIX = 'folder-source:'

export type NewWorkspaceProjectOption =
  | {
      kind: 'project'
      id: string
      projectId: string
      displayName: string
      badgeColor: string
      detail: string
    }
  | {
      kind: 'project-group'
      id: string
      projectGroupId: string
      displayName: string
      badgeColor: string
      detail: string
      parentPath: string
      connectionId: string | null
    }

type NewWorkspaceProjectOptionBase = {
  id: string
  displayName: string
  badgeColor: string
  detail: string
}

export const NEW_WORKSPACE_PROJECT_OPTION_QUERY_MAX_BYTES = 2 * 1024

export function isNewWorkspaceProjectOptionQueryTooLarge(
  query: string,
  maxBytes = NEW_WORKSPACE_PROJECT_OPTION_QUERY_MAX_BYTES
): boolean {
  return isClipboardTextByteLengthOverLimit(query, maxBytes)
}

type BuildNewWorkspaceProjectOptionsInput = {
  projects: readonly Project[]
  projectHostSetups: readonly ProjectHostSetup[]
  eligibleRepos: readonly Repo[]
  hosts?: readonly Pick<ExecutionHostRegistryEntry, 'id' | 'label'>[]
}

type BuildNewWorkspaceCreateTargetOptionsInput = BuildNewWorkspaceProjectOptionsInput & {
  projectGroups: readonly ProjectGroup[]
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
  const hostLabelById = new Map((input.hosts ?? []).map((host) => [host.id, host.label]))
  const readySetupCountsByProjectId = new Map<string, number>()
  const setupDirectoriesByProjectId = new Map<string, ProjectSetupDirectory[]>()

  for (const setup of projectHostSetups) {
    if (setup.setupState !== 'ready' || !eligibleRepoIds.has(setup.repoId)) {
      continue
    }
    readySetupCountsByProjectId.set(
      setup.projectId,
      (readySetupCountsByProjectId.get(setup.projectId) ?? 0) + 1
    )
    const directories = setupDirectoriesByProjectId.get(setup.projectId) ?? []
    directories.push({ path: setup.path, hostId: setup.hostId })
    setupDirectoriesByProjectId.set(setup.projectId, directories)
  }

  const options = projects
    .filter((project) => (readySetupCountsByProjectId.get(project.id) ?? 0) > 0)
    .map((project) => ({
      kind: 'project' as const,
      id: project.id,
      projectId: project.id,
      displayName: project.displayName,
      badgeColor: project.badgeColor,
      detail: getProjectDetail(project, readySetupCountsByProjectId.get(project.id) ?? 0),
      detailSource: project.providerIdentity ? ('provider' as const) : ('generic' as const)
    }))

  const duplicateProjectDetailsById = getDuplicateProjectDetailsById(
    options,
    setupDirectoriesByProjectId,
    hostLabelById
  )

  return options
    .map(({ detailSource: _detailSource, ...option }) => {
      const directoryDetail = duplicateProjectDetailsById.get(option.id)
      return directoryDetail ? { ...option, detail: directoryDetail } : option
    })
    .sort((a, b) => a.displayName.localeCompare(b.displayName) || a.detail.localeCompare(b.detail))
}

function getProjectGroupOptionId(projectGroupId: string): string {
  return `${NEW_WORKSPACE_PROJECT_GROUP_OPTION_PREFIX}${projectGroupId}`
}

function getFolderSourceOptionId(repoId: string): string {
  return `${NEW_WORKSPACE_FOLDER_SOURCE_OPTION_PREFIX}${repoId}`
}

export function getRepoIdFromNewWorkspaceFolderSourceOptionId(optionId: string): string | null {
  return optionId.startsWith(NEW_WORKSPACE_FOLDER_SOURCE_OPTION_PREFIX)
    ? optionId.slice(NEW_WORKSPACE_FOLDER_SOURCE_OPTION_PREFIX.length)
    : null
}

export function getProjectGroupIdFromNewWorkspaceOptionId(optionId: string): string | null {
  return optionId.startsWith(NEW_WORKSPACE_PROJECT_GROUP_OPTION_PREFIX)
    ? optionId.slice(NEW_WORKSPACE_PROJECT_GROUP_OPTION_PREFIX.length)
    : null
}

function getProjectGroupDetail(group: ProjectGroup): string {
  return group.parentPath?.trim() || 'Repo group'
}

export function buildNewWorkspaceFolderSourceOptions(
  repos: readonly Repo[]
): NewWorkspaceProjectOption[] {
  return repos
    .map((repo) => ({
      kind: 'project' as const,
      id: getFolderSourceOptionId(repo.id),
      projectId: repo.id,
      displayName: repo.displayName,
      badgeColor: repo.badgeColor,
      detail: repo.path
    }))
    .sort((a, b) => a.displayName.localeCompare(b.displayName) || a.detail.localeCompare(b.detail))
}

export function buildNewWorkspaceCreateTargetOptions({
  projectGroups,
  ...projectInput
}: BuildNewWorkspaceCreateTargetOptionsInput): NewWorkspaceProjectOption[] {
  const projectOptions = buildNewWorkspaceProjectOptions(projectInput)
  const groupOptions = projectGroups
    .filter((group) => Boolean(group.parentPath?.trim()))
    .map((group) => ({
      kind: 'project-group' as const,
      id: getProjectGroupOptionId(group.id),
      projectGroupId: group.id,
      displayName: group.name,
      badgeColor: group.color ?? 'var(--muted-foreground)',
      detail: getProjectGroupDetail(group),
      parentPath: group.parentPath?.trim() ?? '',
      connectionId: group.connectionId ?? null
    }))

  return [...projectOptions, ...groupOptions].sort(
    (a, b) =>
      a.displayName.localeCompare(b.displayName) ||
      a.detail.localeCompare(b.detail) ||
      a.id.localeCompare(b.id)
  )
}

export function searchNewWorkspaceProjectOptions(
  options: readonly NewWorkspaceProjectOption[],
  rawQuery: string
): NewWorkspaceProjectOption[] {
  if (isNewWorkspaceProjectOptionQueryTooLarge(rawQuery)) {
    return []
  }
  const query = rawQuery.trim().toLowerCase()
  if (!query) {
    return [...options]
  }
  return options.filter((option: NewWorkspaceProjectOptionBase) =>
    [option.displayName, option.detail].some((value) => value.toLowerCase().includes(query))
  )
}
