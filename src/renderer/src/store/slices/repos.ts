/* eslint-disable max-lines -- Why: repo slice owns local/runtime routing,
add/remove/reorder side effects, and cross-slice teardown. Splitting it during
the client-server refactor would obscure the invariants this file is currently
auditing and preserving. */
import type { StateCreator } from 'zustand'
import { toast } from 'sonner'
import type { AppState } from '../types'
import type {
  Project,
  Repo,
  ProjectGroup,
  ProjectHostSetup,
  FolderWorkspace,
  ProjectGroupImportResult,
  NestedRepoScanResult,
  ProjectHostSetupCloneArgs,
  ProjectHostSetupCreateArgs,
  ProjectHostSetupCreateResult,
  ProjectHostSetupDeleteArgs,
  ProjectHostSetupDeleteResult,
  ProjectHostSetupExistingFolderArgs,
  ProjectHostSetupResult,
  ProjectHostSetupUpdateArgs,
  ProjectHostSetupUpdateResult
} from '../../../../shared/types'
import {
  projectHostSetupProjectionFromRepos,
  type ProjectHostSetupProjection
} from '../../../../shared/project-host-setup-projection'
import {
  PROJECT_HOST_SETUP_RUNTIME_CAPABILITY,
  WORKSPACE_RUN_CONTEXT_RUNTIME_CAPABILITY
} from '../../../../shared/protocol-version'
import {
  FOLDER_WORKSPACE_PATH_STATUS_TTL_MS,
  type FolderWorkspacePathStatus,
  type FolderWorkspacePathStatusRequest
} from '../../../../shared/folder-workspace-path-status'
import { isGitRepoKind } from '../../../../shared/repo-kind'
import { sanitizeRepoIcon } from '../../../../shared/repo-icon'
import { normalizeRepoBadgeColor } from '../../../../shared/repo-badge-color'
import { getProjectGroupSubtreeIds } from '../../../../shared/project-groups'
import { isPathInsideOrEqual } from '../../../../shared/cross-platform-path'
import { selectProjectGroupRemovalTargets } from './project-group-removal-targets'
import { getRepoIdFromWorktreeId } from './worktree-helpers'
import { reconcileFetchedRepos } from './repo-identity-reconcile'
import { splitRepoReorderByHost } from './repo-reorder-host-split'
import {
  assertRuntimeEnvironmentCapability,
  callRuntimeRpc,
  getActiveRuntimeTarget
} from '../../runtime/runtime-rpc-client'
import { toRuntimeWorktreeSelector } from '../../runtime/runtime-worktree-selector'
import { buildDismissedOnboardingFolderAgentStartup } from '@/lib/onboarding-folder-agent-startup'
import { markOnboardingProjectAdded } from '@/lib/onboarding-project-checklist'
import { filterSetupScriptPromptDismissalsToValidRepos } from '@/lib/setup-script-prompt'
import { translate } from '@/i18n/i18n'
import {
  getRepoExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  toRuntimeExecutionHostId
} from '../../../../shared/execution-host'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'
import { formatFolderWorkspaceCreateError } from '../../lib/folder-workspace-path-status'

const ERROR_TOAST_DURATION = 60_000

type RepoUpdate = Partial<
  Pick<
    Repo,
    | 'displayName'
    | 'badgeColor'
    | 'repoIcon'
    | 'upstream'
    | 'hookSettings'
    | 'worktreeBaseRef'
    | 'worktreeBasePath'
    | 'kind'
    | 'symlinkPaths'
    | 'issueSourcePreference'
    | 'externalWorktreeVisibility'
    | 'externalWorktreeVisibilityPromptDismissedAt'
    | 'projectGroupId'
    | 'projectGroupOrder'
  >
> & { sourceControlAi?: Repo['sourceControlAi'] | null }

type NestedRepoScanControls = {
  scanId?: string
  onProgress?: (scan: NestedRepoScanResult) => void
}

export type FolderWorkspacePathStatusCacheEntry = {
  status: FolderWorkspacePathStatus
  checkedAt: number
  requestSnapshot: string
}

export type DeleteProjectGroupWithContainedProjectsOptions = {
  removeContainedProjects: boolean
}

export type ProjectRemovalFailure = {
  projectId: string
  reason: string
}

export type DeleteProjectGroupWithContainedProjectsResult =
  | {
      status: 'deleted-group'
      groupId: string
      requestedProjectIds: string[]
      removedProjectIds: string[]
      failedProjectRemovals: ProjectRemovalFailure[]
    }
  | {
      status: 'missing-group' | 'group-delete-failed'
      groupId: string
      requestedProjectIds: string[]
      removedProjectIds: []
      failedProjectRemovals: []
    }

function normalizeNestedRepoScanResult(scan: NestedRepoScanResult): NestedRepoScanResult {
  return {
    ...scan,
    stopped: scan.stopped ?? false,
    maxDepth: scan.maxDepth ?? 3,
    maxRepos: scan.maxRepos ?? 100,
    timeoutMs: scan.timeoutMs ?? null
  }
}

function sanitizeRepoUpdate(updates: RepoUpdate): RepoUpdate {
  const sanitized = { ...updates }
  if ('badgeColor' in sanitized) {
    const badgeColor = normalizeRepoBadgeColor(sanitized.badgeColor)
    if (!badgeColor) {
      delete sanitized.badgeColor
    } else {
      sanitized.badgeColor = badgeColor
    }
  }
  if ('repoIcon' in sanitized) {
    const repoIcon = sanitizeRepoIcon(sanitized.repoIcon)
    if (repoIcon === undefined) {
      delete sanitized.repoIcon
    } else {
      sanitized.repoIcon = repoIcon
    }
  }
  if ('worktreeBasePath' in sanitized && sanitized.worktreeBasePath !== undefined) {
    sanitized.worktreeBasePath = sanitized.worktreeBasePath.trim() || undefined
  }
  return sanitized
}

const updateRepoChainsByStore = new WeakMap<() => AppState, Map<string, Promise<boolean>>>()

function getRepoUpdateChains(get: () => AppState): Map<string, Promise<boolean>> {
  let chains = updateRepoChainsByStore.get(get)
  if (!chains) {
    chains = new Map<string, Promise<boolean>>()
    updateRepoChainsByStore.set(get, chains)
  }
  return chains
}

function getKnownRepoWorktreeIds(state: AppState, projectId: string): string[] {
  const ids = new Set<string>()
  for (const worktree of state.worktreesByRepo[projectId] ?? []) {
    ids.add(worktree.id)
  }
  for (const worktree of state.detectedWorktreesByRepo[projectId]?.worktrees ?? []) {
    ids.add(worktree.id)
  }
  return [...ids]
}

function getRuntimeTargetHostId(
  target: ReturnType<typeof getActiveRuntimeTarget>
): ReturnType<typeof toRuntimeExecutionHostId> | typeof LOCAL_EXECUTION_HOST_ID {
  return target.kind === 'environment'
    ? toRuntimeExecutionHostId(target.environmentId)
    : LOCAL_EXECUTION_HOST_ID
}

function getProjectSetupRuntimeTarget(
  hostId: ProjectHostSetupExistingFolderArgs['hostId']
): ReturnType<typeof getActiveRuntimeTarget> {
  const parsedHost = parseExecutionHostId(hostId)
  return parsedHost?.kind === 'runtime'
    ? { kind: 'environment', environmentId: parsedHost.environmentId }
    : { kind: 'local' }
}

function repoWithFetchedOwner(repo: Repo, target: ReturnType<typeof getActiveRuntimeTarget>): Repo {
  if (repo.connectionId) {
    return { ...repo, executionHostId: getRepoExecutionHostId(repo) }
  }
  return { ...repo, executionHostId: getRuntimeTargetHostId(target) }
}

function setupWithFetchedOwner(
  setup: ProjectHostSetup,
  target: ReturnType<typeof getActiveRuntimeTarget>
): ProjectHostSetup {
  const hostId = getRuntimeTargetHostId(target)
  if (target.kind !== 'environment' || setup.hostId !== LOCAL_EXECUTION_HOST_ID) {
    return setup
  }
  return {
    ...setup,
    hostId,
    executionHostId: hostId
  }
}

async function fetchProjectHostSetupCompatibility(
  target: ReturnType<typeof getActiveRuntimeTarget>,
  repos: readonly Repo[]
): Promise<ProjectHostSetupProjection> {
  try {
    if (target.kind === 'local') {
      const projectsApi = (
        window.api as typeof window.api & {
          projects?: {
            list?: () => Promise<Project[]>
            listHostSetups?: () => Promise<ProjectHostSetup[]>
          }
        }
      ).projects
      if (!projectsApi?.list || !projectsApi.listHostSetups) {
        throw new Error('projects_api_unavailable')
      }
      return {
        projects: await projectsApi.list(),
        setups: await projectsApi.listHostSetups()
      }
    }
    await assertProjectHostSetupRuntimeCapability(target)
    const [projectResponse, setupResponse] = await Promise.all([
      callRuntimeRpc<{ projects: Project[] }>(target, 'project.list', undefined, {
        timeoutMs: 15_000
      }),
      callRuntimeRpc<{ setups: ProjectHostSetup[] }>(target, 'projectHostSetup.list', undefined, {
        timeoutMs: 15_000
      })
    ])
    return {
      projects: projectResponse.projects,
      setups: setupResponse.setups.map((setup) => setupWithFetchedOwner(setup, target))
    }
  } catch {
    // Why: newer clients must still hydrate against older runtimes/preloads
    // that only know `repo.list`; derive the transitional model locally.
    return projectHostSetupProjectionFromRepos(repos)
  }
}

async function assertProjectHostSetupRuntimeCapability(
  target: ReturnType<typeof getActiveRuntimeTarget>
): Promise<void> {
  if (target.kind !== 'environment') {
    return
  }
  await assertRuntimeEnvironmentCapability(
    target.environmentId,
    PROJECT_HOST_SETUP_RUNTIME_CAPABILITY,
    'The selected Orca server does not support project host setup yet. Update Orca on the server and try again.',
    15_000
  )
}

async function assertProjectHostSetupMutationRuntimeCapabilities(
  target: ReturnType<typeof getActiveRuntimeTarget>
): Promise<void> {
  if (target.kind !== 'environment') {
    return
  }
  await assertProjectHostSetupRuntimeCapability(target)
  await assertRuntimeEnvironmentCapability(
    target.environmentId,
    WORKSPACE_RUN_CONTEXT_RUNTIME_CAPABILITY,
    'The selected Orca server does not support explicit workspace run hosts yet. Update Orca on the server and try again.',
    15_000
  )
}

function projectCompatibilityFromRepos(
  repos: readonly Repo[]
): Pick<RepoSlice, 'projects' | 'projectHostSetups'> {
  const projection = projectHostSetupProjectionFromRepos(repos)
  return {
    projects: projection.projects,
    projectHostSetups: projection.setups
  }
}

function mergeProjectHostSetupCompatibility(
  derived: Pick<RepoSlice, 'projects' | 'projectHostSetups'>,
  fetched: ProjectHostSetupProjection
): Pick<RepoSlice, 'projects' | 'projectHostSetups'> {
  const fetchedSetupOwners = new Set(fetched.setups.map(getProjectHostSetupOwnerKey))
  const derivedSetups = derived.projectHostSetups.filter(
    (setup) => !fetchedSetupOwners.has(getProjectHostSetupOwnerKey(setup))
  )
  const projectHostSetups = mergeById(derivedSetups, fetched.setups)
  const setupProjectIds = new Set(projectHostSetups.map((setup) => setup.projectId))
  const fetchedProjectIds = new Set(fetched.projects.map((project) => project.id))
  return {
    projects: mergeById(derived.projects, fetched.projects).filter(
      (project) => fetchedProjectIds.has(project.id) || setupProjectIds.has(project.id)
    ),
    projectHostSetups
  }
}

function getProjectHostSetupOwnerKey(setup: ProjectHostSetup): string {
  return `${setup.hostId}:${setup.repoId ?? setup.id}`
}

function mergeById<T extends { id: string }>(base: readonly T[], overlay: readonly T[]): T[] {
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

function mergeFetchedReposForHost(
  previous: readonly Repo[],
  fetched: Repo[],
  hostId: string
): Repo[] {
  const fetchedIds = new Set(fetched.map((repo) => repo.id))
  const preserved = previous.filter((repo) => {
    const existingHostId = getRepoExecutionHostId(repo)
    return existingHostId !== hostId || fetchedIds.has(repo.id)
  })
  const preservedById = new Map(preserved.map((repo) => [repo.id, repo]))
  const merged = [...preserved]
  for (const repo of fetched) {
    const existingIndex = merged.findIndex((entry) => entry.id === repo.id)
    if (existingIndex === -1) {
      merged.push(repo)
      continue
    }
    merged[existingIndex] = repo
  }
  return reconcileFetchedRepos(
    previous,
    merged.filter((repo) => preservedById.has(repo.id) || fetchedIds.has(repo.id))
  )
}

async function fetchReposForTarget(
  target: ReturnType<typeof getActiveRuntimeTarget>,
  currentRepos: readonly Repo[]
): Promise<{
  repos: Repo[]
  projectCompatibility: Pick<RepoSlice, 'projects' | 'projectHostSetups'>
  hostId: ReturnType<typeof getRuntimeTargetHostId>
}> {
  const fetchedRepos =
    target.kind === 'local'
      ? await window.api.repos.list()
      : (
          await callRuntimeRpc<{ repos: Repo[] }>(target, 'repo.list', undefined, {
            timeoutMs: 15_000
          })
        ).repos
  const hostId = getRuntimeTargetHostId(target)
  const repos = fetchedRepos.map((repo) => repoWithFetchedOwner(repo, target))
  const fetchedProjectCompatibility = await fetchProjectHostSetupCompatibility(target, repos)
  const reconciledRepos = mergeFetchedReposForHost(currentRepos, repos, hostId)
  const projectCompatibility =
    target.kind === 'local'
      ? mergeProjectHostSetupCompatibility(
          projectCompatibilityFromRepos(reconciledRepos),
          fetchedProjectCompatibility
        )
      : mergeProjectHostSetupCompatibility(
          projectCompatibilityFromRepos(reconciledRepos),
          fetchedProjectCompatibility
        )

  return { repos: reconciledRepos, projectCompatibility, hostId }
}

function settingsForRepoOwner(state: Pick<AppState, 'repos' | 'settings'>, repoId: string) {
  const repo = state.repos.find((entry) => entry.id === repoId)
  if (!repo) {
    return state.settings
  }
  if (!repo.executionHostId && !repo.connectionId) {
    return state.settings
  }
  const parsed = parseExecutionHostId(getRepoExecutionHostId(repo))
  if (parsed?.kind === 'runtime') {
    return state.settings
      ? { ...state.settings, activeRuntimeEnvironmentId: parsed.environmentId }
      : ({ activeRuntimeEnvironmentId: parsed.environmentId } as AppState['settings'])
  }
  if (parsed?.kind === 'local' && state.settings?.activeRuntimeEnvironmentId) {
    return { ...state.settings, activeRuntimeEnvironmentId: null }
  }
  if (parsed?.kind !== 'ssh') {
    return state.settings
  }
  // Why: SSH repos are owned through local IPC/SSH plumbing. Existing repo
  // mutations must not follow whichever runtime server is currently focused.
  return state.settings
    ? { ...state.settings, activeRuntimeEnvironmentId: null }
    : ({ activeRuntimeEnvironmentId: null } as AppState['settings'])
}

function getFolderWorkspacePathStatusScopeKey(request: FolderWorkspacePathStatusRequest): string {
  return request.scope === 'project-group'
    ? `project-group:${request.projectGroupId}`
    : `folder-workspace:${request.folderWorkspaceId}`
}

function getRuntimeTargetCachePrefix(state: AppState): string {
  const target = getActiveRuntimeTarget(state.settings)
  return target.kind === 'local' ? 'local' : `environment:${target.environmentId}`
}

function getFolderWorkspaceStatusRequestSnapshot(
  state: Pick<AppState, 'projectGroups' | 'folderWorkspaces' | 'repos' | 'sshConnectionStates'>,
  request: FolderWorkspacePathStatusRequest
): string | null {
  const scope =
    request.scope === 'project-group'
      ? state.projectGroups.find((group) => group.id === request.projectGroupId)
      : state.folderWorkspaces.find((workspace) => workspace.id === request.folderWorkspaceId)
  const projectGroup =
    request.scope === 'project-group'
      ? scope && 'parentPath' in scope
        ? scope
        : null
      : scope && 'projectGroupId' in scope
        ? state.projectGroups.find((group) => group.id === scope.projectGroupId)
        : null
  const folderPath =
    request.scope === 'project-group'
      ? scope && 'parentPath' in scope
        ? scope.parentPath
        : null
      : scope && 'folderPath' in scope
        ? scope.folderPath
        : null
  const projectGroupId =
    request.scope === 'project-group'
      ? request.projectGroupId
      : scope && 'projectGroupId' in scope
        ? scope.projectGroupId
        : null
  const scopeConnectionId =
    request.scope === 'project-group'
      ? scope && 'parentPath' in scope
        ? scope.connectionId
        : null
      : scope && 'folderPath' in scope
        ? (scope.connectionId ?? projectGroup?.connectionId)
        : null
  if (!folderPath || !projectGroupId) {
    return null
  }
  const groupIds = getProjectGroupSubtreeIds(state.projectGroups, projectGroupId)
  const candidateRepos = state.repos.filter(
    (repo) =>
      (typeof repo.projectGroupId === 'string' && groupIds.has(repo.projectGroupId)) ||
      isPathInsideOrEqual(folderPath, repo.path)
  )
  const relevantConnectionIds = new Set<string>()
  if (scopeConnectionId) {
    relevantConnectionIds.add(scopeConnectionId)
  }
  for (const repo of candidateRepos) {
    if (repo.connectionId) {
      relevantConnectionIds.add(repo.connectionId)
    }
  }
  const sshFingerprint = [...relevantConnectionIds]
    .map(
      (connectionId) =>
        `${connectionId}:${state.sshConnectionStates.get(connectionId)?.status ?? 'missing'}`
    )
    .sort()
    .join('|')
  const repoFingerprint = candidateRepos
    .map(
      (repo) => `${repo.id}:${repo.path}:${repo.projectGroupId ?? ''}:${repo.connectionId ?? ''}`
    )
    .sort()
    .join('|')
  return [
    folderPath,
    projectGroupId,
    scopeConnectionId ?? '',
    sshFingerprint,
    repoFingerprint
  ].join('\0')
}

function getFreshFolderWorkspacePathStatusFromCache(args: {
  entry: FolderWorkspacePathStatusCacheEntry | undefined
  requestSnapshot: string | null
}): FolderWorkspacePathStatus | null {
  const { entry, requestSnapshot } = args
  if (!entry || requestSnapshot === null || entry.requestSnapshot !== requestSnapshot) {
    return null
  }
  return Date.now() - entry.checkedAt < FOLDER_WORKSPACE_PATH_STATUS_TTL_MS ? entry.status : null
}

function getFolderWorkspacePathStatusRequestSnapshotForRead(
  state: AppState,
  request: FolderWorkspacePathStatusRequest
): string | null {
  return getFolderWorkspaceStatusRequestSnapshot(state, request)
}

export type RepoSlice = {
  repos: Repo[]
  projects: Project[]
  projectHostSetups: ProjectHostSetup[]
  projectGroups: ProjectGroup[]
  folderWorkspaces: FolderWorkspace[]
  folderWorkspacePathStatuses: Record<string, FolderWorkspacePathStatusCacheEntry>
  activeRepoId: string | null
  fetchRepos: () => Promise<void>
  fetchRuntimeEnvironmentRepos: (environmentId: string) => Promise<Repo[]>
  fetchProjectGroups: () => Promise<void>
  fetchFolderWorkspaces: () => Promise<void>
  addRepo: () => Promise<Repo | null>
  addRepoPath: (path: string, kind?: 'git' | 'folder') => Promise<Repo | null>
  setupProjectExistingFolder: (
    args: ProjectHostSetupExistingFolderArgs
  ) => Promise<ProjectHostSetupResult | null>
  createProjectHostSetup: (
    args: ProjectHostSetupCreateArgs
  ) => Promise<ProjectHostSetupCreateResult | null>
  updateProjectHostSetup: (
    args: ProjectHostSetupUpdateArgs
  ) => Promise<ProjectHostSetupUpdateResult | null>
  deleteProjectHostSetup: (
    args: ProjectHostSetupDeleteArgs
  ) => Promise<ProjectHostSetupDeleteResult | null>
  setupProjectClone: (args: ProjectHostSetupCloneArgs) => Promise<ProjectHostSetupResult | null>
  addNonGitFolder: (path: string) => Promise<Repo | null>
  scanNestedRepos: (
    path: string,
    connectionId?: string,
    controls?: NestedRepoScanControls
  ) => Promise<NestedRepoScanResult | null>
  cancelNestedRepoScan: (scanId: string) => Promise<boolean>
  importNestedRepos: (args: {
    parentPath: string
    groupName: string
    projectPaths: string[]
    connectionId?: string
    scanId?: string
    mode: 'group' | 'separate'
  }) => Promise<ProjectGroupImportResult | null>
  createProjectGroup: (name: string) => Promise<ProjectGroup | null>
  createFolderWorkspace: (args: {
    projectGroupId: string
    name?: string
    folderPath?: string | null
    connectionId?: string | null
    linkedTask?: FolderWorkspace['linkedTask']
    createdWithAgent?: FolderWorkspace['createdWithAgent']
    pendingFirstAgentMessageRename?: boolean
  }) => Promise<FolderWorkspace | null>
  getFolderWorkspacePathStatusCacheKey: (request: FolderWorkspacePathStatusRequest) => string
  getFreshFolderWorkspacePathStatus: (
    request: FolderWorkspacePathStatusRequest
  ) => FolderWorkspacePathStatus | null
  fetchFolderWorkspacePathStatus: (
    request: FolderWorkspacePathStatusRequest,
    options?: { force?: boolean }
  ) => Promise<FolderWorkspacePathStatus | null>
  updateFolderWorkspace: (
    folderWorkspaceId: string,
    updates: Partial<
      Pick<
        FolderWorkspace,
        | 'name'
        | 'folderPath'
        | 'linkedTask'
        | 'comment'
        | 'isArchived'
        | 'isUnread'
        | 'isPinned'
        | 'sortOrder'
        | 'manualOrder'
        | 'workspaceStatus'
        | 'createdWithAgent'
        | 'pendingFirstAgentMessageRename'
        | 'firstAgentMessageRenameError'
        | 'lastActivityAt'
      >
    >
  ) => Promise<boolean>
  deleteFolderWorkspace: (folderWorkspaceId: string) => Promise<boolean>
  updateProjectGroup: (
    groupId: string,
    updates: Partial<Pick<ProjectGroup, 'name' | 'isCollapsed' | 'tabOrder' | 'color'>>
  ) => Promise<boolean>
  deleteProjectGroup: (groupId: string) => Promise<boolean>
  deleteProjectGroupWithContainedProjects: (
    groupId: string,
    options: DeleteProjectGroupWithContainedProjectsOptions
  ) => Promise<DeleteProjectGroupWithContainedProjectsResult>
  moveProjectToGroup: (
    projectId: string,
    groupId: string | null,
    order?: number
  ) => Promise<boolean>
  removeProject: (projectId: string) => Promise<void>
  updateRepo: (projectId: string, updates: RepoUpdate) => Promise<boolean>
  setActiveRepo: (projectId: string | null) => void
  reorderRepos: (orderedIds: string[]) => Promise<void>
}

export const createRepoSlice: StateCreator<AppState, [], [], RepoSlice> = (set, get) => ({
  repos: [],
  projects: [],
  projectHostSetups: [],
  projectGroups: [],
  folderWorkspaces: [],
  folderWorkspacePathStatuses: {},
  activeRepoId: null,

  fetchRepos: async () => {
    try {
      const target = getActiveRuntimeTarget(get().settings)
      const { repos: reconciledRepos, projectCompatibility } = await fetchReposForTarget(
        target,
        get().repos
      )
      set((s) => {
        const validRepoIds = new Set(reconciledRepos.map((repo) => repo.id))
        return {
          repos: reconciledRepos,
          ...projectCompatibility,
          folderWorkspacePathStatuses: {},
          activeRepoId: s.activeRepoId && validRepoIds.has(s.activeRepoId) ? s.activeRepoId : null,
          filterRepoIds: s.filterRepoIds.filter((projectId) => validRepoIds.has(projectId)),
          setupScriptPromptDismissedRepoIds: filterSetupScriptPromptDismissalsToValidRepos(
            s.setupScriptPromptDismissedRepoIds,
            validRepoIds
          )
        }
      })
    } catch (err) {
      console.error('Failed to fetch repos:', err)
    }
  },

  fetchRuntimeEnvironmentRepos: async (environmentId) => {
    try {
      const target = { kind: 'environment' as const, environmentId }
      const {
        repos: reconciledRepos,
        projectCompatibility,
        hostId
      } = await fetchReposForTarget(target, get().repos)
      const validRepoIds = new Set(reconciledRepos.map((repo) => repo.id))
      set((s) => ({
        repos: reconciledRepos,
        ...projectCompatibility,
        activeRepoId: s.activeRepoId && validRepoIds.has(s.activeRepoId) ? s.activeRepoId : null,
        filterRepoIds: s.filterRepoIds.filter((projectId) => validRepoIds.has(projectId)),
        setupScriptPromptDismissedRepoIds: filterSetupScriptPromptDismissalsToValidRepos(
          s.setupScriptPromptDismissedRepoIds,
          validRepoIds
        )
      }))
      return reconciledRepos.filter((repo) => getRepoExecutionHostId(repo) === hostId)
    } catch (err) {
      console.error(`Failed to fetch repos for runtime environment ${environmentId}:`, err)
      return []
    }
  },

  fetchProjectGroups: async () => {
    try {
      const target = getActiveRuntimeTarget(get().settings)
      const projectGroups =
        target.kind === 'local'
          ? await window.api.projectGroups.list()
          : (
              await callRuntimeRpc<{ groups: ProjectGroup[] }>(
                target,
                'projectGroup.list',
                undefined,
                {
                  timeoutMs: 15_000
                }
              )
            ).groups
      set({ projectGroups, folderWorkspacePathStatuses: {} })
    } catch (err) {
      console.error('Failed to fetch project groups:', err)
    }
  },

  fetchFolderWorkspaces: async () => {
    try {
      const target = getActiveRuntimeTarget(get().settings)
      const folderWorkspaces =
        target.kind === 'local'
          ? await window.api.folderWorkspaces.list()
          : (
              await callRuntimeRpc<{ folderWorkspaces: FolderWorkspace[] }>(
                target,
                'folderWorkspace.list',
                undefined,
                { timeoutMs: 15_000 }
              )
            ).folderWorkspaces
      set({ folderWorkspaces, folderWorkspacePathStatuses: {} })
    } catch (err) {
      console.error('Failed to fetch folder workspaces:', err)
    }
  },

  getFolderWorkspacePathStatusCacheKey: (request) =>
    `${getRuntimeTargetCachePrefix(get())}:${getFolderWorkspacePathStatusScopeKey(request)}`,

  getFreshFolderWorkspacePathStatus: (request) => {
    const state = get()
    const cacheKey = get().getFolderWorkspacePathStatusCacheKey(request)
    const cached = state.folderWorkspacePathStatuses[cacheKey]
    const requestSnapshot = getFolderWorkspacePathStatusRequestSnapshotForRead(state, request)
    return getFreshFolderWorkspacePathStatusFromCache({ entry: cached, requestSnapshot })
  },

  fetchFolderWorkspacePathStatus: async (request, options) => {
    const cacheKey = get().getFolderWorkspacePathStatusCacheKey(request)
    const requestSnapshot = getFolderWorkspaceStatusRequestSnapshot(get(), request)
    const cached = get().folderWorkspacePathStatuses[cacheKey]
    const freshCachedStatus = getFreshFolderWorkspacePathStatusFromCache({
      entry: cached,
      requestSnapshot
    })
    if (!options?.force && freshCachedStatus) {
      return freshCachedStatus
    }
    try {
      const target = getActiveRuntimeTarget(get().settings)
      const status =
        target.kind === 'local'
          ? await window.api.folderWorkspaces.getPathStatus(request)
          : (
              await callRuntimeRpc<{ status: FolderWorkspacePathStatus }>(
                target,
                'folderWorkspace.getPathStatus',
                request,
                { timeoutMs: 15_000 }
              )
            ).status
      set((state) => ({
        folderWorkspacePathStatuses:
          requestSnapshot !== null &&
          getFolderWorkspaceStatusRequestSnapshot(state, request) === requestSnapshot
            ? {
                ...state.folderWorkspacePathStatuses,
                [cacheKey]: { status, checkedAt: Date.now(), requestSnapshot }
              }
            : state.folderWorkspacePathStatuses
      }))
      return status
    } catch (err) {
      console.error('Failed to fetch folder workspace path status:', err)
      return null
    }
  },

  scanNestedRepos: async (path, connectionId, controls) => {
    try {
      const target = getActiveRuntimeTarget(get().settings)
      if (target.kind === 'local') {
        const unsubscribe =
          controls?.scanId && controls.onProgress
            ? window.api.projectGroups.onNestedScanProgress(({ scanId, scan }) => {
                if (scanId === controls.scanId) {
                  controls.onProgress?.(normalizeNestedRepoScanResult(scan))
                }
              })
            : undefined
        try {
          return normalizeNestedRepoScanResult(
            await window.api.projectGroups.scanNested({
              path,
              connectionId,
              scanId: controls?.scanId
            })
          )
        } finally {
          unsubscribe?.()
        }
      }
      return normalizeNestedRepoScanResult(
        await callRuntimeRpc<NestedRepoScanResult>(
          target,
          'projectGroup.scanNested',
          { path },
          // Why: older runtime servers cannot stream or cancel scans, so the
          // renderer must retain a bounded failure path for large folders.
          { timeoutMs: 20_000 }
        )
      )
    } catch (err) {
      console.error('Failed to scan nested repos:', err)
      return null
    }
  },

  cancelNestedRepoScan: async (scanId) => {
    try {
      const target = getActiveRuntimeTarget(get().settings)
      if (target.kind !== 'local') {
        return false
      }
      return await window.api.projectGroups.cancelNestedScan({ scanId })
    } catch (err) {
      console.error('Failed to cancel nested repo scan:', err)
      return false
    }
  },

  importNestedRepos: async (args) => {
    try {
      const target = getActiveRuntimeTarget(get().settings)
      const result =
        target.kind === 'local'
          ? await window.api.projectGroups.importNested(args)
          : await callRuntimeRpc<ProjectGroupImportResult>(
              target,
              'projectGroup.importNested',
              {
                parentPath: args.parentPath,
                groupName: args.groupName,
                projectPaths: args.projectPaths,
                scanId: args.scanId,
                mode: args.mode
              },
              { timeoutMs: 60_000 }
            )
      await get().fetchProjectGroups()
      await get().fetchFolderWorkspaces()
      await get().fetchRepos()
      set({ folderWorkspacePathStatuses: {} })
      return result
    } catch (err) {
      console.error('Failed to import nested repos:', err)
      toast.error(
        translate('auto.store.slices.repos.6d3318e813', 'Failed to import repositories'),
        {
          description: err instanceof Error ? err.message : String(err)
        }
      )
      return null
    }
  },

  createProjectGroup: async (name) => {
    try {
      const target = getActiveRuntimeTarget(get().settings)
      const group =
        target.kind === 'local'
          ? await window.api.projectGroups.create({
              name,
              createdFrom: 'manual'
            })
          : (
              await callRuntimeRpc<{ group: ProjectGroup }>(
                target,
                'projectGroup.create',
                { name, createdFrom: 'manual' },
                { timeoutMs: 15_000 }
              )
            ).group
      set((s) => ({ projectGroups: [...s.projectGroups, group], folderWorkspacePathStatuses: {} }))
      return group
    } catch (err) {
      console.error('Failed to create project group:', err)
      return null
    }
  },

  createFolderWorkspace: async (args) => {
    try {
      const target = getActiveRuntimeTarget(get().settings)
      const workspace =
        target.kind === 'local'
          ? await window.api.folderWorkspaces.create(args)
          : (
              await callRuntimeRpc<{ folderWorkspace: FolderWorkspace }>(
                target,
                'folderWorkspace.create',
                args,
                { timeoutMs: 15_000 }
              )
            ).folderWorkspace
      set((s) => ({
        folderWorkspaces: [workspace, ...s.folderWorkspaces],
        folderWorkspacePathStatuses: {}
      }))
      return workspace
    } catch (err) {
      console.error('Failed to create folder workspace:', err)
      const { title, description } = formatFolderWorkspaceCreateError(err)
      toast.error(title, { description, duration: ERROR_TOAST_DURATION })
      return null
    }
  },

  updateFolderWorkspace: async (folderWorkspaceId, updates) => {
    try {
      const target = getActiveRuntimeTarget(get().settings)
      const updated =
        target.kind === 'local'
          ? await window.api.folderWorkspaces.update({ folderWorkspaceId, updates })
          : (
              await callRuntimeRpc<{ folderWorkspace: FolderWorkspace | null }>(
                target,
                'folderWorkspace.update',
                { folderWorkspaceId, updates },
                { timeoutMs: 15_000 }
              )
            ).folderWorkspace
      if (!updated) {
        return false
      }
      set((s) => ({
        folderWorkspaces: s.folderWorkspaces.map((workspace) =>
          workspace.id === folderWorkspaceId ? updated : workspace
        ),
        folderWorkspacePathStatuses: {}
      }))
      return true
    } catch (err) {
      console.error('Failed to update folder workspace:', err)
      return false
    }
  },

  deleteFolderWorkspace: async (folderWorkspaceId) => {
    try {
      const target = getActiveRuntimeTarget(get().settings)
      const deleted =
        target.kind === 'local'
          ? await window.api.folderWorkspaces.delete({ folderWorkspaceId })
          : (
              await callRuntimeRpc<{ deleted: boolean }>(
                target,
                'folderWorkspace.delete',
                { folderWorkspaceId },
                { timeoutMs: 15_000 }
              )
            ).deleted
      if (!deleted) {
        return false
      }
      const workspaceKey = folderWorkspaceKey(folderWorkspaceId)
      set((s) => ({
        folderWorkspaces: s.folderWorkspaces.filter(
          (workspace) => workspace.id !== folderWorkspaceId
        ),
        folderWorkspacePathStatuses: {}
      }))
      get().purgeWorktreeTerminalState([workspaceKey])
      return true
    } catch (err) {
      console.error('Failed to delete folder workspace:', err)
      return false
    }
  },

  updateProjectGroup: async (groupId, updates) => {
    try {
      // Why: project groups are focused-host-scoped by design — fetch/create/update/
      // delete all route by the focused host, and the list is replaced (not merged).
      const target = getActiveRuntimeTarget(get().settings)
      const updated =
        target.kind === 'local'
          ? await window.api.projectGroups.update({ groupId, updates })
          : (
              await callRuntimeRpc<{ group: ProjectGroup | null }>(
                target,
                'projectGroup.update',
                { groupId, updates },
                { timeoutMs: 15_000 }
              )
            ).group
      if (!updated) {
        return false
      }
      set((s) => ({
        projectGroups: s.projectGroups.map((group) => (group.id === groupId ? updated : group)),
        folderWorkspacePathStatuses: {}
      }))
      return true
    } catch (err) {
      console.error('Failed to update project group:', err)
      return false
    }
  },

  deleteProjectGroup: async (groupId) => {
    try {
      // Why: project groups are focused-host-scoped by design (see updateProjectGroup).
      const target = getActiveRuntimeTarget(get().settings)
      const deleted =
        target.kind === 'local'
          ? await window.api.projectGroups.delete({ groupId })
          : (
              await callRuntimeRpc<{ deleted: boolean }>(
                target,
                'projectGroup.delete',
                { groupId },
                { timeoutMs: 15_000 }
              )
            ).deleted
      if (!deleted) {
        return false
      }
      set((s) => {
        const deletedGroupIds = getProjectGroupSubtreeIds(s.projectGroups, groupId)
        return {
          projectGroups: s.projectGroups.filter((group) => !deletedGroupIds.has(group.id)),
          folderWorkspaces: s.folderWorkspaces.filter(
            (workspace) => !deletedGroupIds.has(workspace.projectGroupId)
          ),
          repos: s.repos.map((repo) =>
            repo.projectGroupId && deletedGroupIds.has(repo.projectGroupId)
              ? { ...repo, projectGroupId: null }
              : repo
          ),
          folderWorkspacePathStatuses: {}
        }
      })
      return true
    } catch (err) {
      console.error('Failed to delete project group:', err)
      return false
    }
  },

  deleteProjectGroupWithContainedProjects: async (groupId, options) => {
    const targets = selectProjectGroupRemovalTargets(get().projectGroups, get().repos, groupId)
    const requestedProjectIds = options.removeContainedProjects ? targets.projectIds : []
    if (!targets.groupExists) {
      return {
        status: 'missing-group',
        groupId,
        requestedProjectIds,
        removedProjectIds: [],
        failedProjectRemovals: []
      }
    }

    const deleted = await get().deleteProjectGroup(groupId)
    if (!deleted) {
      return {
        status: 'group-delete-failed',
        groupId,
        requestedProjectIds,
        removedProjectIds: [],
        failedProjectRemovals: []
      }
    }

    if (!options.removeContainedProjects) {
      return {
        status: 'deleted-group',
        groupId,
        requestedProjectIds,
        removedProjectIds: [],
        failedProjectRemovals: []
      }
    }

    const removedProjectIds: string[] = []
    const failedProjectRemovals: ProjectRemovalFailure[] = []
    for (const projectId of targets.projectIds) {
      const existedBeforeRemoval = get().repos.some((repo) => repo.id === projectId)
      try {
        if (existedBeforeRemoval) {
          await get().removeProject(projectId)
        }
      } catch (err) {
        console.error('Failed to remove contained project:', err)
      }
      const stillExists = get().repos.some((repo) => repo.id === projectId)
      if (stillExists) {
        failedProjectRemovals.push({
          projectId,
          reason: 'Project remained in Orca after removeProject completed.'
        })
      } else {
        removedProjectIds.push(projectId)
      }
    }

    return {
      status: 'deleted-group',
      groupId,
      requestedProjectIds,
      removedProjectIds,
      failedProjectRemovals
    }
  },

  moveProjectToGroup: async (projectId, groupId, order) => {
    try {
      const target = getActiveRuntimeTarget(settingsForRepoOwner(get(), projectId))
      const moved =
        target.kind === 'local'
          ? await window.api.projectGroups.moveProject({
              projectId,
              groupId,
              order
            })
          : (
              await callRuntimeRpc<{ repo: Repo | null }>(
                target,
                'projectGroup.moveProject',
                { repo: projectId, groupId, order },
                { timeoutMs: 15_000 }
              )
            ).repo
      if (!moved) {
        return false
      }
      const ownedMoved = repoWithFetchedOwner(moved, target)
      set((s) => ({
        repos: s.repos.map((repo) => (repo.id === projectId ? ownedMoved : repo)),
        folderWorkspacePathStatuses: {}
      }))
      return true
    } catch (err) {
      console.error('Failed to move repo to group:', err)
      return false
    }
  },

  addRepoPath: async (path, kind = 'git') => {
    try {
      const target = getActiveRuntimeTarget(get().settings)
      let repo: Repo
      try {
        if (target.kind === 'local') {
          const result = await window.api.repos.add({ path, kind })
          if ('error' in result) {
            throw new Error(result.error)
          }
          repo = result.repo
        } else {
          repo = (
            await callRuntimeRpc<{ repo: Repo }>(
              target,
              'repo.add',
              { path, kind },
              { timeoutMs: 15_000 }
            )
          ).repo
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        if (kind !== 'git' || !message.includes('Not a valid git repository')) {
          throw err
        }
        // Why: folder mode is a capability downgrade, not a silent fallback.
        // Show an in-app confirmation dialog so users understand that worktrees,
        // SCM, PRs, and checks will be unavailable for this root. The dialog's
        // OK handler calls addNonGitFolder to complete the flow.
        const { openModal } = get()
        openModal('confirm-non-git-folder', { folderPath: path })
        return null
      }
      repo = repoWithFetchedOwner(repo, target)
      const alreadyAdded = get().repos.some((r) => r.id === repo.id)
      if (alreadyAdded) {
        get().clearOrcaHookTrustForRepo(repo.id)
      }
      set((s) => {
        if (s.repos.some((r) => r.id === repo.id)) {
          return s
        }
        const nextRepos = [...s.repos, repo]
        return {
          repos: nextRepos,
          ...projectCompatibilityFromRepos(nextRepos),
          folderWorkspacePathStatuses: {}
        }
      })
      if (alreadyAdded) {
        toast.info(translate('auto.store.slices.repos.a8e4b3af5b', 'Project already added'), {
          description: repo.displayName
        })
      } else {
        toast.success(
          isGitRepoKind(repo)
            ? translate('auto.store.slices.repos.8bb3ad7935', 'Project added')
            : translate('auto.store.slices.repos.90d129b48b', 'Folder added'),
          {
            description: repo.displayName
          }
        )
      }
      return repo
    } catch (err) {
      console.error('Failed to add project:', err)
      const message = err instanceof Error ? err.message : String(err)
      const duration = ERROR_TOAST_DURATION
      toast.error(translate('auto.store.slices.repos.c6e022ddfc', 'Failed to add project'), {
        description: message,
        duration
      })
      return null
    }
  },

  setupProjectExistingFolder: async (args) => {
    try {
      const target = getProjectSetupRuntimeTarget(args.hostId)
      await assertProjectHostSetupMutationRuntimeCapabilities(target)
      const result =
        target.kind === 'local'
          ? await window.api.projects.setupExistingFolder(args)
          : (
              await callRuntimeRpc<{ result: ProjectHostSetupResult }>(
                target,
                'projectHostSetup.setupExistingFolder',
                args,
                { timeoutMs: 15_000 }
              )
            ).result
      const repo = repoWithFetchedOwner(result.repo, target)
      const setup = setupWithFetchedOwner(result.setup, target)
      set((s) => {
        const nextRepos = s.repos.some((entry) => entry.id === repo.id)
          ? s.repos.map((entry) => (entry.id === repo.id ? repo : entry))
          : [...s.repos, repo]
        const nextProjects = s.projects.some((entry) => entry.id === result.project.id)
          ? s.projects.map((entry) => (entry.id === result.project.id ? result.project : entry))
          : [...s.projects, result.project]
        const nextSetups = s.projectHostSetups.some((entry) => entry.id === setup.id)
          ? s.projectHostSetups.map((entry) => (entry.id === setup.id ? setup : entry))
          : [...s.projectHostSetups, setup]
        return {
          repos: nextRepos,
          projects: nextProjects,
          projectHostSetups: nextSetups
        }
      })
      toast.success(translate('auto.store.slices.repos.8bb3ad7935', 'Project added'), {
        description: repo.displayName
      })
      return { ...result, repo, setup }
    } catch (err) {
      console.error('Failed to set up project on host:', err)
      const message = err instanceof Error ? err.message : String(err)
      toast.error(translate('auto.store.slices.repos.c6e022ddfc', 'Failed to add project'), {
        description: message,
        duration: ERROR_TOAST_DURATION
      })
      return null
    }
  },

  createProjectHostSetup: async (args) => {
    try {
      const target = getProjectSetupRuntimeTarget(args.hostId)
      await assertProjectHostSetupMutationRuntimeCapabilities(target)
      const result =
        target.kind === 'local'
          ? await window.api.projects.createHostSetup(args)
          : (
              await callRuntimeRpc<{ result: ProjectHostSetupCreateResult }>(
                target,
                'projectHostSetup.create',
                args,
                { timeoutMs: 15_000 }
              )
            ).result
      const setup = setupWithFetchedOwner(result.setup, target)
      set((s) => ({
        projects: s.projects.some((entry) => entry.id === result.project.id)
          ? s.projects.map((entry) => (entry.id === result.project.id ? result.project : entry))
          : [...s.projects, result.project],
        projectHostSetups: s.projectHostSetups.some((entry) => entry.id === setup.id)
          ? s.projectHostSetups.map((entry) => (entry.id === setup.id ? setup : entry))
          : [...s.projectHostSetups, setup]
      }))
      return { project: result.project, setup }
    } catch (err) {
      console.error('Failed to create project host setup:', err)
      const message = err instanceof Error ? err.message : String(err)
      toast.error(translate('auto.store.slices.repos.c6e022ddfc', 'Failed to add project'), {
        description: message,
        duration: ERROR_TOAST_DURATION
      })
      return null
    }
  },

  updateProjectHostSetup: async (args) => {
    try {
      const currentSetup = get().projectHostSetups.find((setup) => setup.id === args.setupId)
      const target = currentSetup
        ? getProjectSetupRuntimeTarget(currentSetup.hostId)
        : { kind: 'local' as const }
      await assertProjectHostSetupMutationRuntimeCapabilities(target)
      const result =
        target.kind === 'local'
          ? await window.api.projects.updateHostSetup(args)
          : (
              await callRuntimeRpc<{ result: ProjectHostSetupUpdateResult }>(
                target,
                'projectHostSetup.update',
                args,
                { timeoutMs: 15_000 }
              )
            ).result
      const setup = setupWithFetchedOwner(result.setup, target)
      const repo = result.repo ? repoWithFetchedOwner(result.repo, target) : undefined
      set((s) => ({
        repos: repo
          ? s.repos.some((entry) => entry.id === repo.id)
            ? s.repos.map((entry) => (entry.id === repo.id ? repo : entry))
            : [...s.repos, repo]
          : s.repos,
        projects: s.projects.some((entry) => entry.id === result.project.id)
          ? s.projects.map((entry) => (entry.id === result.project.id ? result.project : entry))
          : [...s.projects, result.project],
        projectHostSetups: s.projectHostSetups.some((entry) => entry.id === setup.id)
          ? s.projectHostSetups.map((entry) => (entry.id === setup.id ? setup : entry))
          : [...s.projectHostSetups, setup]
      }))
      return { ...result, repo, setup }
    } catch (err) {
      console.error('Failed to update project host setup:', err)
      const message = err instanceof Error ? err.message : String(err)
      toast.error(translate('auto.store.slices.repos.c6e022ddfc', 'Failed to add project'), {
        description: message,
        duration: ERROR_TOAST_DURATION
      })
      return null
    }
  },

  deleteProjectHostSetup: async (args) => {
    try {
      const currentSetup = get().projectHostSetups.find((setup) => setup.id === args.setupId)
      const target = currentSetup
        ? getProjectSetupRuntimeTarget(currentSetup.hostId)
        : { kind: 'local' as const }
      await assertProjectHostSetupMutationRuntimeCapabilities(target)
      const result =
        target.kind === 'local'
          ? await window.api.projects.deleteHostSetup(args)
          : (
              await callRuntimeRpc<{ result: ProjectHostSetupDeleteResult }>(
                target,
                'projectHostSetup.delete',
                args,
                { timeoutMs: 15_000 }
              )
            ).result
      const repo = result.repo ? repoWithFetchedOwner(result.repo, target) : undefined
      set((s) => {
        const projectHostSetups = s.projectHostSetups.filter(
          (setup) => setup.id !== result.setup.id
        )
        const repos = repo ? s.repos.filter((entry) => entry.id !== repo.id) : s.repos
        const projects =
          repo && !projectHostSetups.some((setup) => setup.projectId === result.project.id)
            ? s.projects.filter((project) => project.id !== result.project.id)
            : s.projects
        return { repos, projects, projectHostSetups }
      })
      return { ...result, repo }
    } catch (err) {
      console.error('Failed to delete project host setup:', err)
      const message = err instanceof Error ? err.message : String(err)
      toast.error(translate('auto.store.slices.repos.c6e022ddfc', 'Failed to add project'), {
        description: message,
        duration: ERROR_TOAST_DURATION
      })
      return null
    }
  },

  setupProjectClone: async (args) => {
    try {
      const parsedHost = parseExecutionHostId(args.hostId)
      const target = getProjectSetupRuntimeTarget(args.hostId)
      if (parsedHost?.kind !== 'ssh') {
        await assertProjectHostSetupMutationRuntimeCapabilities(target)
      }
      const repo =
        parsedHost?.kind === 'ssh'
          ? await window.api.repos.cloneRemote({
              connectionId: parsedHost.targetId,
              url: args.url,
              destination: args.destination
            })
          : target.kind === 'local'
            ? await window.api.repos.clone({
                url: args.url,
                destination: args.destination
              })
            : (
                await callRuntimeRpc<{ repo: Repo }>(
                  target,
                  'repo.clone',
                  {
                    url: args.url,
                    destination: args.destination
                  },
                  { timeoutMs: 10 * 60_000 }
                )
              ).repo
      return await get().setupProjectExistingFolder({
        projectId: args.projectId,
        hostId: args.hostId,
        path: repo.path,
        kind: 'git',
        displayName: args.displayName,
        setupMethod: 'cloned'
      })
    } catch (err) {
      console.error('Failed to clone project on host:', err)
      const message = err instanceof Error ? err.message : String(err)
      toast.error(translate('auto.store.slices.repos.c6e022ddfc', 'Failed to add project'), {
        description: message,
        duration: ERROR_TOAST_DURATION
      })
      return null
    }
  },

  addRepo: async () => {
    const target = getActiveRuntimeTarget(get().settings)
    if (target.kind !== 'local') {
      // Why: OS folder pickers return client-local paths. Remote environments
      // need an explicit host path, which the Add Project dialog handles.
      toast.error(
        translate(
          'auto.store.slices.repos.e649269645',
          'Use Add Project to enter a path on the selected host.'
        )
      )
      return null
    }
    const path = await window.api.repos.pickFolder()
    if (!path) {
      return null
    }
    return get().addRepoPath(path)
  },

  addNonGitFolder: async (path) => {
    try {
      const hadProjectBeforeAdd = get().repos.length > 0
      const repo = await get().addRepoPath(path, 'folder')
      if (!repo) {
        return null
      }
      await markOnboardingProjectAdded('addedFolder')
      // Why: without focusing the new folder, the UI looks unchanged after
      // the dialog closes and users think nothing happened. Fetch the
      // synthetic folder worktree and route through the standard activation
      // sequence so the sidebar reveals and opens the folder the same way
      // clicking a worktree card does. Lazy-imported to avoid a circular
      // module load (worktree-activation imports the store root).
      await get().fetchWorktrees(repo.id)
      const folderWorktree = get().worktreesByRepo[repo.id]?.[0]
      if (folderWorktree) {
        const { activateAndRevealWorktree } = await import('../../lib/worktree-activation')
        const onboarding = await window.api.onboarding.get().catch(() => null)
        // Why: a new user can dismiss the wizard, then immediately add their
        // first folder from Landing. That path skips onboarding's completeRepo
        // hook, so carry the selected default agent into the first terminal here.
        const startup = buildDismissedOnboardingFolderAgentStartup(
          get().settings,
          onboarding,
          hadProjectBeforeAdd
        )
        activateAndRevealWorktree(folderWorktree.id, {
          sidebarRevealBehavior: 'auto',
          ...(startup ? { startup } : {})
        })
      }
      return repo
    } catch (err) {
      console.error('Failed to add folder:', err)
      const message = err instanceof Error ? err.message : String(err)
      toast.error(translate('auto.store.slices.repos.b7e14472ae', 'Failed to add folder'), {
        description: message,
        duration: ERROR_TOAST_DURATION
      })
      return null
    }
  },

  removeProject: async (projectId) => {
    try {
      const target = getActiveRuntimeTarget(settingsForRepoOwner(get(), projectId))
      await (target.kind === 'local'
        ? window.api.repos.remove({ repoId: projectId })
        : callRuntimeRpc(target, 'repo.rm', { repo: projectId }, { timeoutMs: 15_000 }))

      get().clearOrcaHookTrustForRepo(projectId)
      const repoPath = get().repos.find((repo) => repo.id === projectId)?.path
      get().evictGitHubRepoCaches(projectId, repoPath)
      const { clearRepoSlugCacheEntry } = await import('../../lib/repo-slug-index')
      clearRepoSlugCacheEntry(projectId)

      // Kill PTYs for all worktrees belonging to this repo
      const worktreeIds = getKnownRepoWorktreeIds(get(), projectId)
      const killedTabIds = new Set<string>()
      const killedPtyIds = new Set<string>()
      if (target.kind === 'environment') {
        await Promise.allSettled(
          worktreeIds.map((worktreeId) =>
            callRuntimeRpc(
              target,
              'terminal.stop',
              { worktree: toRuntimeWorktreeSelector(worktreeId) },
              { timeoutMs: 15_000 }
            )
          )
        )
      }
      for (const wId of worktreeIds) {
        const tabs = get().tabsByWorktree[wId] ?? []
        for (const tab of tabs) {
          killedTabIds.add(tab.id)
          for (const ptyId of get().ptyIdsByTabId[tab.id] ?? []) {
            killedPtyIds.add(ptyId)
            if (!ptyId.startsWith('remote:')) {
              window.api.pty.kill(ptyId)
            }
          }
        }
      }

      set((s) => {
        const nextWorktrees = { ...s.worktreesByRepo }
        delete nextWorktrees[projectId]
        const nextDetectedWorktrees = { ...s.detectedWorktreesByRepo }
        delete nextDetectedWorktrees[projectId]
        const nextTabs = { ...s.tabsByWorktree }
        const nextLayouts = { ...s.terminalLayoutsByTabId }
        const nextPtyIdsByTabId = { ...s.ptyIdsByTabId }
        const nextRuntimePaneTitlesByTabId = { ...s.runtimePaneTitlesByTabId }
        const nextSuppressedPtyExitIds = { ...s.suppressedPtyExitIds }
        for (const wId of worktreeIds) {
          delete nextTabs[wId]
        }
        for (const tabId of killedTabIds) {
          delete nextLayouts[tabId]
          delete nextPtyIdsByTabId[tabId]
          delete nextRuntimePaneTitlesByTabId[tabId]
        }
        for (const ptyId of killedPtyIds) {
          nextSuppressedPtyExitIds[ptyId] = true
        }
        // Why: editor state is worktree-scoped. Removing a repo must also
        // remove open editor files and per-worktree active-file tracking for
        // all worktrees that belonged to the repo, otherwise orphaned entries
        // would persist in the session save and pollute state.
        const worktreeIdSet = new Set(worktreeIds)
        const nextOpenFiles = s.openFiles.filter((f) => !worktreeIdSet.has(f.worktreeId))
        const nextActiveFileIdByWorktree = { ...s.activeFileIdByWorktree }
        const nextActiveTabTypeByWorktree = { ...s.activeTabTypeByWorktree }
        for (const wId of worktreeIds) {
          delete nextActiveFileIdByWorktree[wId]
          delete nextActiveTabTypeByWorktree[wId]
        }
        const activeFileCleared = s.activeFileId
          ? s.openFiles.some((f) => f.id === s.activeFileId && worktreeIdSet.has(f.worktreeId))
          : false
        // Why: pruneLastVisitedTimestamps defers entries for repos missing
        // from worktreesByRepo (treats them as not-yet-hydrated SSH repos).
        // Drop this repo's timestamps explicitly so they cannot survive prune
        // forever after the repo is removed.
        let nextLastVisitedAtByWorktreeId = s.lastVisitedAtByWorktreeId
        for (const id of Object.keys(s.lastVisitedAtByWorktreeId)) {
          if (getRepoIdFromWorktreeId(id) === projectId) {
            if (nextLastVisitedAtByWorktreeId === s.lastVisitedAtByWorktreeId) {
              nextLastVisitedAtByWorktreeId = { ...s.lastVisitedAtByWorktreeId }
            }
            delete nextLastVisitedAtByWorktreeId[id]
          }
        }
        const nextRepos = s.repos.filter((r) => r.id !== projectId)
        return {
          repos: nextRepos,
          ...projectCompatibilityFromRepos(nextRepos),
          activeRepoId: s.activeRepoId === projectId ? null : s.activeRepoId,
          filterRepoIds: s.filterRepoIds.filter((id) => id !== projectId),
          worktreesByRepo: nextWorktrees,
          detectedWorktreesByRepo: nextDetectedWorktrees,
          tabsByWorktree: nextTabs,
          ptyIdsByTabId: nextPtyIdsByTabId,
          runtimePaneTitlesByTabId: nextRuntimePaneTitlesByTabId,
          suppressedPtyExitIds: nextSuppressedPtyExitIds,
          terminalLayoutsByTabId: nextLayouts,
          activeTabId: s.activeTabId && killedTabIds.has(s.activeTabId) ? null : s.activeTabId,
          openFiles: nextOpenFiles,
          activeFileIdByWorktree: nextActiveFileIdByWorktree,
          activeTabTypeByWorktree: nextActiveTabTypeByWorktree,
          activeFileId: activeFileCleared ? null : s.activeFileId,
          activeTabType: activeFileCleared ? 'terminal' : s.activeTabType,
          lastVisitedAtByWorktreeId: nextLastVisitedAtByWorktreeId,
          folderWorkspacePathStatuses: {},
          sortEpoch: s.sortEpoch + 1,
          // Why: removing the last repo while in settings leaves activeView as
          // 'settings', which renders an empty settings pane instead of Landing.
          // Also clear activeWorktreeId so App renders Landing (it checks
          // !activeWorktreeId). Without this, the terminal surface shows instead.
          ...(nextRepos.length === 0
            ? {
                activeView: 'terminal' as const,
                activeWorktreeId: null,
                activeWorkspaceKey: null,
                activeRepoId: null
              }
            : {})
        }
      })
    } catch (err) {
      console.error('Failed to remove repo:', err)
    }
  },

  updateRepo: async (projectId, updates) => {
    const updateRepoChains = getRepoUpdateChains(get)
    const applyRepoUpdate = async () => {
      try {
        const sanitizedUpdates = sanitizeRepoUpdate(updates)
        const target = getActiveRuntimeTarget(settingsForRepoOwner(get(), projectId))
        const updatedRepo =
          target.kind === 'local'
            ? await window.api.repos.update({ repoId: projectId, updates: sanitizedUpdates })
            : (
                await callRuntimeRpc<{ repo: Repo }>(
                  target,
                  'repo.update',
                  { repo: projectId, updates: sanitizedUpdates },
                  { timeoutMs: 15_000 }
                )
              ).repo
        set((s) => {
          const nextRepos = s.repos.map((r) => {
            if (r.id !== projectId) {
              return r
            }
            if (updatedRepo) {
              return repoWithFetchedOwner(updatedRepo, target)
            }
            if (sanitizedUpdates.sourceControlAi === null) {
              const { sourceControlAi: _sourceControlAi, ...repoWithoutSourceControlAi } = r
              const { sourceControlAi: _clearedSourceControlAi, ...updatesWithoutSourceControlAi } =
                sanitizedUpdates
              return { ...repoWithoutSourceControlAi, ...updatesWithoutSourceControlAi }
            }
            const { sourceControlAi, ...updatesWithoutSourceControlAi } = sanitizedUpdates
            return {
              ...r,
              ...updatesWithoutSourceControlAi,
              ...(sourceControlAi !== undefined ? { sourceControlAi } : {})
            }
          })
          return {
            repos: nextRepos,
            ...projectCompatibilityFromRepos(nextRepos),
            folderWorkspacePathStatuses: {}
          }
        })
        return true
      } catch (err) {
        console.error('Failed to update repo:', err)
        return false
      }
    }
    const previous = updateRepoChains.get(projectId)
    // Why: repo settings are persisted as full nested values. Preserve call
    // order per repo so a slower IPC/RPC response cannot overwrite newer state.
    const next = previous
      ? previous.catch(() => undefined).then(applyRepoUpdate)
      : applyRepoUpdate()
    updateRepoChains.set(projectId, next)
    const cleanup = () => {
      if (updateRepoChains.get(projectId) === next) {
        updateRepoChains.delete(projectId)
      }
    }
    void next.then(cleanup, cleanup)
    return next
  },

  setActiveRepo: (projectId) => set({ activeRepoId: projectId }),

  reorderRepos: async (orderedIds) => {
    // Optimistically apply the new order so the sidebar updates instantly;
    // resync only if main rejects (stale permutation due to a racing add/remove).
    const previous = get().repos
    const byId = new Map(previous.map((r) => [r.id, r]))
    const next: Repo[] = []
    for (const id of orderedIds) {
      const repo = byId.get(id)
      if (repo) {
        next.push(repo)
      }
    }
    if (next.length !== previous.length) {
      // Caller passed a non-permutation — refuse to apply locally.
      return
    }
    set({
      repos: next,
      ...projectCompatibilityFromRepos(next),
      folderWorkspacePathStatuses: {}
    })
    try {
      // Why: each host persists only its own repos and rejects non-permutations,
      // so split the cross-host order into per-host permutations and dispatch one
      // reorder per owner host.
      const groups = splitRepoReorderByHost(orderedIds, next, get().settings)
      const results = await Promise.all(
        groups.map(async (group) => {
          const parsed = parseExecutionHostId(group.hostId)
          const target =
            parsed?.kind === 'runtime'
              ? ({ kind: 'environment', environmentId: parsed.environmentId } as const)
              : ({ kind: 'local' } as const)
          return target.kind === 'local'
            ? window.api.repos.reorder({ orderedIds: group.orderedIds })
            : callRuntimeRpc<{ status: 'applied' | 'rejected' }>(
                target,
                'repo.reorder',
                { orderedIds: group.orderedIds },
                { timeoutMs: 15_000 }
              )
        })
      )
      if (results.some((result) => result.status === 'rejected')) {
        await get().fetchRepos()
      }
    } catch (err) {
      console.error('Failed to reorder repos:', err)
      await get().fetchRepos()
    }
  }
})
