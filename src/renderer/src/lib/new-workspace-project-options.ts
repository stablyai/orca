import { buildProjectSetupRepoLookup } from './project-setup-repo-lookup'
import type { ProjectGroupingSettings } from '../../../shared/project-grouping'
import {
  buildProjectGroupingIndex,
  type ProjectGroupingIndex
} from '../../../shared/project-section-grouping'
import { projectHostSetupProjectionFromRepos } from '../../../shared/project-host-setup-projection'
import type { ProjectGroup } from '../../../shared/project-group-types'
import type { Project, ProjectHostSetup } from '../../../shared/project-types'
import type { Repo } from '../../../shared/repo-types'
import { isClipboardTextByteLengthOverLimit } from '../../../shared/clipboard-text'
import type { ExecutionHostRegistryEntry } from '../../../shared/execution-host-registry'
import { getRepoExecutionHostId, type ExecutionHostId } from '../../../shared/execution-host'
import {
  getDuplicateProjectDetailsById,
  type ProjectSetupDirectory
} from './new-workspace-duplicate-project-details'

export const NEW_WORKSPACE_PROJECT_GROUP_OPTION_PREFIX = 'project-group:'

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

export const NEW_WORKSPACE_PROJECT_OPTION_QUERY_MAX_BYTES = 2 * 1024

export function isNewWorkspaceProjectOptionQueryTooLarge(
  query: string,
  maxBytes = NEW_WORKSPACE_PROJECT_OPTION_QUERY_MAX_BYTES
): boolean {
  return isClipboardTextByteLengthOverLimit(query, maxBytes)
}

type BuildNewWorkspaceProjectOptionsInput = {
  settings?: ProjectGroupingSettings | null
  grouping?: ProjectGroupingIndex
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
  const repoLookup = buildProjectSetupRepoLookup(eligibleRepos)
  const hostLabelById = new Map((input.hosts ?? []).map((host) => [host.id, host.label]))
  const liveHostIds = input.hosts ? new Set(input.hosts.map((host) => host.id)) : null
  const readySetupCountsByProjectId = new Map<string, number>()
  const setupDirectoriesByProjectId = new Map<string, ProjectSetupDirectory[]>()

  for (const setup of projectHostSetups) {
    if (
      setup.setupState !== 'ready' ||
      !repoLookup.resolve(setup) ||
      (liveHostIds && !liveHostIds.has(setup.hostId))
    ) {
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

  const index =
    input.grouping ??
    buildProjectGroupingIndex({ projects, projectHostSetups, settings: input.settings })
  const projectById = new Map(projects.map((project) => [project.id, project]))
  const projectHostSetupsById = new Map(
    projectHostSetups.map((setup) => [`${setup.hostId}\0${setup.id}`, setup])
  )
  const groups = index.groups
  const options = groups
    .filter((group) =>
      group.registrations.some(
        (setup) =>
          projectHostSetupsById.get(`${setup.hostId}\0${setup.id}`)?.setupState === 'ready' &&
          repoLookup.resolve(setup) &&
          (!liveHostIds || liveHostIds.has(setup.hostId))
      )
    )
    .flatMap((group) => {
      const project = projectById.get(group.representative.projectId)
      if (!project) {
        return []
      }
      setupDirectoriesByProjectId.set(
        group.key,
        group.registrations
          .filter(
            (setup) =>
              projectHostSetupsById.get(`${setup.hostId}\0${setup.id}`)?.setupState === 'ready' &&
              repoLookup.resolve(setup) &&
              (!liveHostIds || liveHostIds.has(setup.hostId))
          )
          .map((setup) => ({ path: setup.path, hostId: setup.hostId }))
      )
      return [
        {
          kind: 'project' as const,
          id: group.key,
          projectId: group.key,
          displayName: group.label,
          badgeColor: project.badgeColor,
          detail: getProjectDetail(project, readySetupCountsByProjectId.get(project.id) ?? 0),
          detailSource: project.providerIdentity ? ('provider' as const) : ('generic' as const)
        }
      ]
    })

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

export function getProjectGroupIdFromNewWorkspaceOptionId(optionId: string): string | null {
  return optionId.startsWith(NEW_WORKSPACE_PROJECT_GROUP_OPTION_PREFIX)
    ? optionId.slice(NEW_WORKSPACE_PROJECT_GROUP_OPTION_PREFIX.length)
    : null
}

function getProjectGroupDetail(group: ProjectGroup): string {
  return group.parentPath?.trim() || 'Repo group'
}

export function getNewWorkspaceProjectGroupHostId(group: ProjectGroup): ExecutionHostId {
  return getRepoExecutionHostId(group)
}

/** Require actionable hosts for folder selection, draft restore and retention of an existing pick. */
export function findActionableFolderProjectGroup({
  projectGroups,
  groupId,
  actionableHostIds
}: {
  projectGroups: readonly ProjectGroup[]
  groupId: string | null | undefined
  actionableHostIds: ReadonlySet<ExecutionHostId>
}): ProjectGroup | null {
  if (!groupId) {
    return null
  }
  return (
    projectGroups.find(
      (group) =>
        group.id === groupId &&
        Boolean(group.parentPath?.trim()) &&
        actionableHostIds.has(getNewWorkspaceProjectGroupHostId(group))
    ) ?? null
  )
}

export function buildNewWorkspaceCreateTargetOptions({
  projectGroups,
  ...projectInput
}: BuildNewWorkspaceCreateTargetOptionsInput): NewWorkspaceProjectOption[] {
  const projectOptions = buildNewWorkspaceProjectOptions(projectInput)
  const liveHostIds = projectInput.hosts ? new Set(projectInput.hosts.map((host) => host.id)) : null
  const groupOptions = projectGroups
    .filter(
      (group) =>
        Boolean(group.parentPath?.trim()) &&
        (!liveHostIds || liveHostIds.has(getNewWorkspaceProjectGroupHostId(group)))
    )
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
