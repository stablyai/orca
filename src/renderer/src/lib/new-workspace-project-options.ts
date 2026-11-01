import { projectHostSetupProjectionFromRepos } from '../../../shared/project-host-setup-projection'
import type { ProjectGroup } from '../../../shared/project-group-types'
import type { Project, ProjectHostSetup } from '../../../shared/project-types'
import type { Repo } from '../../../shared/repo-types'
import { isClipboardTextByteLengthOverLimit } from '../../../shared/clipboard-text'
import type { ExecutionHostRegistryEntry } from '../../../shared/execution-host-registry'
import { getRepoExecutionHostId, type ExecutionHostId } from '../../../shared/execution-host'
import {
  buildProjectGroupingIndex,
  isCheckoutScopedProjectSetup
} from '../../../shared/project-section-grouping'
import {
  getDuplicateProjectDetailsById,
  type ProjectSetupDirectory
} from './new-workspace-duplicate-project-details'

export const NEW_WORKSPACE_PROJECT_GROUP_OPTION_PREFIX = 'project-group:'
const NEW_WORKSPACE_PROJECT_CHECKOUT_OPTION_PREFIX = 'project-checkout:'

/** One of several same-host checkouts of a project; the sidebar shows each as its own section. */
export type NewWorkspaceProjectCheckout = {
  projectHostSetupId: string
  hostId: ExecutionHostId
  repoId: string
}

export type NewWorkspaceProjectOption =
  | {
      kind: 'project'
      id: string
      projectId: string
      displayName: string
      badgeColor: string
      detail: string
      checkout?: NewWorkspaceProjectCheckout
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
  const eligibleRepoById = new Map(eligibleRepos.map((repo) => [repo.id, repo]))
  const hostLabelById = new Map((input.hosts ?? []).map((host) => [host.id, host.label]))
  const liveHostIds = input.hosts ? new Set(input.hosts.map((host) => host.id)) : null
  const groupingIndex = buildProjectGroupingIndex({ projects, projectHostSetups })
  const readySetupCountsByProjectId = new Map<string, number>()
  const setupDirectoriesByProjectId = new Map<string, ProjectSetupDirectory[]>()
  const checkoutSetups: ProjectHostSetup[] = []

  for (const setup of projectHostSetups) {
    if (
      setup.setupState !== 'ready' ||
      !eligibleRepoById.has(setup.repoId) ||
      (liveHostIds && !liveHostIds.has(setup.hostId))
    ) {
      continue
    }
    // Why: same-host checkouts of one remote share a project id; each stays selectable, as in the sidebar.
    if (groupingIndex && isCheckoutScopedProjectSetup(setup, groupingIndex)) {
      checkoutSetups.push(setup)
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

  const projectById = new Map(projects.map((project) => [project.id, project]))
  const checkoutOptions = checkoutSetups.flatMap((setup) => {
    const project = projectById.get(setup.projectId)
    return project
      ? [
          {
            kind: 'project' as const,
            id: getProjectCheckoutOptionId(setup),
            projectId: project.id,
            displayName: eligibleRepoById.get(setup.repoId)?.displayName || setup.displayName,
            badgeColor: project.badgeColor,
            detail: setup.path,
            checkout: { projectHostSetupId: setup.id, hostId: setup.hostId, repoId: setup.repoId }
          }
        ]
      : []
  })

  return [
    ...options.map(({ detailSource: _detailSource, ...option }) => {
      const directoryDetail = duplicateProjectDetailsById.get(option.id)
      return directoryDetail ? { ...option, detail: directoryDetail } : option
    }),
    ...checkoutOptions
  ].sort((a, b) => a.displayName.localeCompare(b.displayName) || a.detail.localeCompare(b.detail))
}

// Setup ids can repeat across hosts, so a checkout is keyed by both.
function getCheckoutKey(projectHostSetupId: string, hostId: ExecutionHostId): string {
  return JSON.stringify([hostId, projectHostSetupId])
}

function getProjectCheckoutOptionId(setup: Pick<ProjectHostSetup, 'id' | 'hostId'>): string {
  return `${NEW_WORKSPACE_PROJECT_CHECKOUT_OPTION_PREFIX}${getCheckoutKey(setup.id, setup.hostId)}`
}

/** The picker row for the composer's resolved setup: its checkout row when it has one, else its project row. */
export function getSelectedNewWorkspaceProjectOptionId(
  options: readonly NewWorkspaceProjectOption[],
  selectedProjectId: string | null,
  projectHostSetupId: string | null | undefined,
  hostId: ExecutionHostId | null | undefined
): string | null {
  const checkoutOption = options.find(
    (option) =>
      option.kind === 'project' &&
      option.checkout !== undefined &&
      option.checkout.projectHostSetupId === projectHostSetupId &&
      option.checkout.hostId === hostId
  )
  return checkoutOption?.id ?? selectedProjectId
}

/** Setups a project row stands for; its checkout rows own the rest. */
export function getProjectRowHostSetups(
  options: readonly NewWorkspaceProjectOption[],
  projectHostSetups: readonly ProjectHostSetup[]
): readonly ProjectHostSetup[] {
  const checkoutKeys = new Set(
    options.flatMap((option) =>
      option.kind === 'project' && option.checkout
        ? [getCheckoutKey(option.checkout.projectHostSetupId, option.checkout.hostId)]
        : []
    )
  )
  return checkoutKeys.size === 0
    ? projectHostSetups
    : projectHostSetups.filter((setup) => !checkoutKeys.has(getCheckoutKey(setup.id, setup.hostId)))
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
