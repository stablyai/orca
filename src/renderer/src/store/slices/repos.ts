/* eslint-disable max-lines -- Why: repo slice owns local/runtime routing,
add/remove/reorder side effects, and cross-slice teardown. Splitting it during
the client-server refactor would obscure the invariants this file is currently
auditing and preserving. */
import type { StateCreator } from 'zustand'
import { toast } from 'sonner'
import type { AppState } from '../types'
import type { SshRepoReadoption } from '../../../../shared/ssh-types'
import type {
  GlobalSettings,
  Project,
  ProjectUpdateArgs,
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
  getProjectIdentityKey,
  projectHostSetupProjectionFromRepos,
  type ProjectHostSetupProjection
} from '../../../../shared/project-host-setup-projection'
import {
  FOLDER_WORKSPACE_PATH_STATUS_RUNTIME_CAPABILITY,
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
import { getRepoIdFromWorktreeId } from '../../../../shared/worktree-id'
import { selectProjectGroupRemovalTargets } from './project-group-removal-targets'
import { reconcileFetchedRepos } from './repo-identity-reconcile'
import {
  mergeSshRepoReadoptions,
  reconcileReadoptedSshRepoRows,
  type SshRepoReconciliation
} from './superseded-ssh-repo-rows'
import { reconcileReadoptedSshWorktreesByRepo } from './readopted-ssh-worktree-rows'
import { splitRepoReorderByHost } from './repo-reorder-host-split'
import { omitSparsePresetsForRepos } from './sparse-presets'
import {
  findRepoForHost,
  getRepoHostIdentity,
  getRepoHostIdentityForParts,
  repoMatchesHostIdentity
} from './repo-host-identity'
import {
  assertRuntimeEnvironmentCapability,
  callRuntimeRpc,
  getActiveRuntimeTarget
} from '../../runtime/runtime-rpc-client'
import { syncRuntimeGitForkDefaultBranch } from '../../runtime/runtime-git-client'
import { toRuntimeWorktreeSelector } from '../../runtime/runtime-worktree-selector'
import { buildDismissedOnboardingFolderAgentStartup } from '@/lib/onboarding-folder-agent-startup'
import { markOnboardingProjectAdded } from '@/lib/onboarding-project-checklist'
import { filterSetupScriptPromptDismissalsToValidRepos } from '@/lib/setup-script-prompt'
import { notifyInstalledAgentSkillsChanged } from '@/hooks/useInstalledAgentSkills'
import { translate } from '@/i18n/i18n'
import {
  getRepoExecutionHostId,
  isRuntimeOwnedSshTargetId,
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  toRuntimeExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import { cleanupEphemeralVmRuntimesForDeleted } from '@/lib/ephemeral-vm-runtime-cleanup'
import { folderWorkspaceKey, parseWorkspaceKey } from '../../../../shared/workspace-scope'
import { formatFolderWorkspaceCreateError } from '../../lib/folder-workspace-path-status'

const ERROR_TOAST_DURATION = 60_000
const SAFE_AUTO_FORK_SYNC_COOLDOWN_MS = 10 * 60 * 1000
const safeAutoForkSyncAttempts = new Map<string, { attemptedAt: number; promise?: Promise<void> }>()

export type RepoUpdate = Partial<
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
    | 'forkSyncMode'
    | 'externalWorktreeVisibility'
    | 'externalWorktreeVisibilityPromptDismissedAt'
    | 'externalWorktreeInboxBaselinePaths'
    | 'importedExternalWorktreePaths'
    | 'projectGroupId'
    | 'projectGroupOrder'
  >
> & {
  sourceControlAi?: Repo['sourceControlAi'] | null
  externalWorktreeDiscoverySuppressedAt?: Repo['externalWorktreeDiscoverySuppressedAt'] | null
}

type ProjectUpdate = ProjectUpdateArgs['updates']

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

type AllHostCatalogFetchOptions = {
  remoteHosts?: 'include' | 'skip'
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
  if (
    'forkSyncMode' in sanitized &&
    sanitized.forkSyncMode !== undefined &&
    sanitized.forkSyncMode !== 'ask' &&
    sanitized.forkSyncMode !== 'safe-auto' &&
    sanitized.forkSyncMode !== 'off'
  ) {
    delete sanitized.forkSyncMode
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

function worktreeBelongsToHost(worktree: { hostId?: string }, hostId: string): boolean {
  return (worktree.hostId ?? LOCAL_EXECUTION_HOST_ID) === hostId
}

function getKnownRepoWorktreeIds(state: AppState, projectId: string, hostId?: string): string[] {
  const ids = new Set<string>()
  for (const worktree of state.worktreesByRepo[projectId] ?? []) {
    if (!hostId || worktreeBelongsToHost(worktree, hostId)) {
      ids.add(worktree.id)
    }
  }
  for (const worktree of state.detectedWorktreesByRepo[projectId]?.worktrees ?? []) {
    if (!hostId || worktreeBelongsToHost(worktree, hostId)) {
      ids.add(worktree.id)
    }
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

function getProjectUpdateRuntimeTarget(
  state: AppState,
  projectId: string
): ReturnType<typeof getActiveRuntimeTarget> {
  const target = getActiveRuntimeTarget(state.settings)
  if (target.kind !== 'environment') {
    return target
  }
  const runtimeHostId = getRuntimeTargetHostId(target)
  return state.projectHostSetups.some(
    (setup) => setup.projectId === projectId && setup.hostId === runtimeHostId
  )
    ? target
    : { kind: 'local' }
}

function getSafeAutoForkSyncKey(repo: Repo): string {
  return `${getRepoExecutionHostId(repo)}:${repo.id}:${repo.path}`
}

function formatProjectPresenceProfileNames(profileNames: readonly string[]): string {
  const names = [...new Set(profileNames.map((name) => name.trim()).filter(Boolean))]
  if (names.length <= 3) {
    return names.join(', ')
  }
  // Why: the "+N more" overflow suffix is user-visible toast copy and must localize.
  return translate('auto.store.slices.repos.presenceProfileOverflow', '{{names}} +{{count}} more', {
    names: names.slice(0, 3).join(', '),
    count: names.length - 3
  })
}

async function warnIfProjectKnownInAnotherProfile(
  repo: Repo,
  activeOrcaProfileId: string | null
): Promise<void> {
  const findProjectProfiles = window.api.orcaProfiles?.findProjectProfiles
  // Why: without a loaded active profile ID the scan cannot exclude the
  // current profile and would false-positive on the project just added.
  if (!findProjectProfiles || !activeOrcaProfileId) {
    return
  }
  try {
    const result = await findProjectProfiles({
      path: repo.path,
      connectionId: repo.connectionId ?? null,
      executionHostId: getRepoExecutionHostId(repo),
      excludeProfileId: activeOrcaProfileId
    })
    const description = formatProjectPresenceProfileNames(
      result.projects.map((project) => project.profileName)
    )
    if (!description) {
      return
    }
    toast.warning(
      translate('auto.store.slices.repos.2dcd706774', 'Project also exists in another profile'),
      { description }
    )
  } catch (err) {
    // Why: adding a project should not fail because an advisory profile scan failed.
    console.warn('Failed to check project presence in other profiles:', err)
  }
}

function scheduleSafeAutoForkSync(get: () => AppState, repos: readonly Repo[]): void {
  for (const repo of repos) {
    if (repo.kind === 'folder' || repo.forkSyncMode !== 'safe-auto' || !repo.upstream) {
      continue
    }
    const key = getSafeAutoForkSyncKey(repo)
    const existingAttempt = safeAutoForkSyncAttempts.get(key)
    const now = Date.now()
    if (
      existingAttempt?.promise ||
      (existingAttempt && now - existingAttempt.attemptedAt < SAFE_AUTO_FORK_SYNC_COOLDOWN_MS)
    ) {
      continue
    }
    const promise = syncRuntimeGitForkDefaultBranch(
      {
        settings: settingsForRepoOwner(get(), repo.id),
        worktreeId: repo.id,
        worktreePath: repo.path,
        connectionId: repo.connectionId ?? undefined
      },
      repo.upstream
    )
      .then(() => undefined)
      .catch((error) => {
        // Why: safe-auto is opportunistic. Auth/protection/divergence failures
        // should not create startup noise; the settings row exposes Sync Now
        // for explicit, toast-backed diagnosis.
        console.info('Safe fork auto-sync skipped', error)
      })
      .finally(() => {
        const current = safeAutoForkSyncAttempts.get(key)
        if (current?.promise === promise) {
          safeAutoForkSyncAttempts.set(key, { attemptedAt: now })
        }
      })
    safeAutoForkSyncAttempts.set(key, { attemptedAt: now, promise })
  }
}

function repoWithFetchedOwner(repo: Repo, target: ReturnType<typeof getActiveRuntimeTarget>): Repo {
  if (target.kind === 'environment') {
    return { ...repo, executionHostId: getRuntimeTargetHostId(target) }
  }
  if (repo.connectionId) {
    return { ...repo, executionHostId: getRepoExecutionHostId(repo) }
  }
  return repo.executionHostId ? repo : { ...repo, executionHostId: LOCAL_EXECUTION_HOST_ID }
}

function projectGroupWithFetchedOwner(
  projectGroup: ProjectGroup,
  target: ReturnType<typeof getActiveRuntimeTarget>
): ProjectGroup {
  if (target.kind === 'environment') {
    return { ...projectGroup, executionHostId: getRuntimeTargetHostId(target) }
  }
  if (projectGroup.connectionId) {
    return { ...projectGroup, executionHostId: toSshExecutionHostId(projectGroup.connectionId) }
  }
  return { ...projectGroup, executionHostId: LOCAL_EXECUTION_HOST_ID }
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

function mergeProjectCompatibilityProject(base: Project, overlay: Project): Project {
  const localWindowsRuntimePreference =
    'localWindowsRuntimePreference' in overlay
      ? overlay.localWindowsRuntimePreference
      : base.localWindowsRuntimePreference
  const project: Project = {
    ...base,
    ...overlay,
    // Why: all-host startup fetches hosts separately; one host's project record
    // must not erase repo ownership learned from another host with the same id.
    sourceRepoIds: [...new Set([...base.sourceRepoIds, ...overlay.sourceRepoIds])],
    createdAt: Math.min(base.createdAt, overlay.createdAt),
    updatedAt: Math.max(base.updatedAt, overlay.updatedAt)
  }
  if (localWindowsRuntimePreference === undefined) {
    delete project.localWindowsRuntimePreference
  } else {
    project.localWindowsRuntimePreference = localWindowsRuntimePreference
  }
  return project
}

function mergeProjectCompatibilityProjects(
  base: readonly Project[],
  overlay: readonly Project[]
): Project[] {
  const merged = [...base]
  const indexById = new Map(merged.map((entry, index) => [entry.id, index]))
  for (const entry of overlay) {
    const index = indexById.get(entry.id)
    if (index === undefined) {
      indexById.set(entry.id, merged.length)
      merged.push(entry)
    } else {
      merged[index] = mergeProjectCompatibilityProject(merged[index]!, entry)
    }
  }
  return merged
}

function mergeUpdatedProjectCompatibilityProject(
  base: Project,
  updated: Project,
  updates: ProjectUpdate
): Project {
  const project = mergeProjectCompatibilityProject(base, updated)
  if ('localWindowsRuntimePreference' in updates) {
    const localWindowsRuntimePreference =
      'localWindowsRuntimePreference' in updated
        ? updated.localWindowsRuntimePreference
        : updates.localWindowsRuntimePreference
    // Why: project.update returns one host's project record, but preference
    // clears must still override the cross-host metadata preservation merge.
    if (localWindowsRuntimePreference === undefined) {
      delete project.localWindowsRuntimePreference
    } else {
      project.localWindowsRuntimePreference = localWindowsRuntimePreference
    }
  }
  return project
}

function getCurrentSourceRepoIds(project: Project, currentRepoIds: ReadonlySet<string>): string[] {
  return project.sourceRepoIds.filter((repoId) => currentRepoIds.has(repoId))
}

function getReposById(repos: readonly Repo[]): Map<string, Repo[]> {
  const reposById = new Map<string, Repo[]>()
  for (const repo of repos) {
    const existing = reposById.get(repo.id)
    if (existing) {
      existing.push(repo)
    } else {
      reposById.set(repo.id, [repo])
    }
  }
  return reposById
}

function getSourceRepoIdsOutsideHost(
  project: Project,
  reposById: ReadonlyMap<string, readonly Repo[]>,
  hostId: string
): string[] {
  return project.sourceRepoIds.filter((repoId) => {
    const repos = reposById.get(repoId) ?? []
    return repos.some((repo) => getRepoExecutionHostId(repo) !== hostId)
  })
}

function getMergedSourceRepoIdsForHostRefresh(
  previous: Project,
  current: Project,
  reposById: ReadonlyMap<string, readonly Repo[]>,
  hostId: string
): string[] {
  return [
    ...new Set([
      ...getSourceRepoIdsOutsideHost(previous, reposById, hostId),
      ...getCurrentSourceRepoIds(current, new Set(reposById.keys()))
    ])
  ]
}

function projectWithCurrentSourceRepoIds(
  project: Project,
  currentRepoIds: ReadonlySet<string>
): Project {
  const sourceRepoIds = getCurrentSourceRepoIds(project, currentRepoIds)
  return sourceRepoIds.length === project.sourceRepoIds.length
    ? project
    : { ...project, sourceRepoIds }
}

function mergePreviousProjectMetadata(
  previous: Project,
  current: Project,
  reposById: ReadonlyMap<string, readonly Repo[]>,
  hostId: string
): Project {
  const project = mergeProjectCompatibilityProject(previous, current)
  if (hostId === LOCAL_EXECUTION_HOST_ID) {
    // Why: `localWindowsRuntimePreference` belongs to the local host; a local
    // refresh that omits it is authoritative and should clear stale renderer state.
    if ('localWindowsRuntimePreference' in current) {
      if (current.localWindowsRuntimePreference === undefined) {
        delete project.localWindowsRuntimePreference
      } else {
        project.localWindowsRuntimePreference = current.localWindowsRuntimePreference
      }
    } else {
      delete project.localWindowsRuntimePreference
    }
  } else if (previous.localWindowsRuntimePreference !== undefined) {
    // Why: remote runtimes can have their own local Windows preference; they must
    // not overwrite the client-local project runtime setting.
    project.localWindowsRuntimePreference = previous.localWindowsRuntimePreference
  }
  return {
    ...project,
    // Why: fetched project metadata can lag behind repo.list; repo ownership
    // must track the freshly reconciled repos so removed host repos do not linger.
    sourceRepoIds: getMergedSourceRepoIdsForHostRefresh(previous, current, reposById, hostId)
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
  const projectHostSetups = mergeProjectHostSetupsByOwner(derivedSetups, fetched.setups)
  const setupProjectIds = new Set(projectHostSetups.map((setup) => setup.projectId))
  const fetchedProjectIds = new Set(fetched.projects.map((project) => project.id))
  return {
    projects: mergeProjectCompatibilityProjects(derived.projects, fetched.projects).filter(
      (project) => fetchedProjectIds.has(project.id) || setupProjectIds.has(project.id)
    ),
    projectHostSetups
  }
}

function getProjectHostSetupOwnerKey(setup: ProjectHostSetup): string {
  return `${setup.hostId}:${setup.repoId || setup.id}`
}

function mergeProjectHostSetupsByOwner(
  base: readonly ProjectHostSetup[],
  overlay: readonly ProjectHostSetup[]
): ProjectHostSetup[] {
  const merged = [...base]
  const indexByOwner = new Map(
    merged.map((entry, index) => [getProjectHostSetupOwnerKey(entry), index])
  )
  for (const entry of overlay) {
    const index = indexByOwner.get(getProjectHostSetupOwnerKey(entry))
    if (index === undefined) {
      indexByOwner.set(getProjectHostSetupOwnerKey(entry), merged.length)
      merged.push(entry)
    } else {
      merged[index] = entry
    }
  }
  return merged
}

function getProjectHostIds(
  project: Project,
  setups: readonly ProjectHostSetup[],
  repos: readonly Repo[]
): Set<string> {
  const hostIds = getExplicitProjectHostIds(project, setups, repos)
  if (hostIds.size === 0) {
    hostIds.add(LOCAL_EXECUTION_HOST_ID)
  }
  return hostIds
}

function getExplicitProjectHostIds(
  project: Project,
  setups: readonly ProjectHostSetup[],
  repos: readonly Repo[]
): Set<string> {
  const hostIds = new Set<string>()
  const sourceRepoIds = new Set(project.sourceRepoIds)
  for (const setup of setups) {
    if (setup.projectId === project.id) {
      hostIds.add(setup.hostId)
    }
  }
  for (const repo of repos) {
    if (sourceRepoIds.has(repo.id)) {
      hostIds.add(getRepoExecutionHostId(repo))
    }
  }
  return hostIds
}

function mergeFetchedProjectCompatibilityForHost({
  previous,
  fetched,
  repos,
  hostId
}: {
  previous: Pick<RepoSlice, 'projects' | 'projectHostSetups'>
  fetched: Pick<RepoSlice, 'projects' | 'projectHostSetups'>
  repos: readonly Repo[]
  hostId: string
}): Pick<RepoSlice, 'projects' | 'projectHostSetups'> {
  const setupBelongsToFetchedCatalog = (setup: ProjectHostSetup): boolean => {
    if (hostId !== LOCAL_EXECUTION_HOST_ID) {
      return setup.hostId === hostId
    }
    const owner = parseExecutionHostId(setup.hostId)
    // Why: desktop persistence owns local and direct-SSH setups; runtime setups
    // remain authoritative on their remote Orca server.
    return setup.hostId === LOCAL_EXECUTION_HOST_ID || owner?.kind === 'ssh'
  }
  const fetchedSetupsForHost = fetched.projectHostSetups.filter(setupBelongsToFetchedCatalog)
  const preservedSetups = previous.projectHostSetups.filter(
    (setup) => !setupBelongsToFetchedCatalog(setup)
  )
  const projectHostSetups = mergeProjectHostSetupsByOwner(preservedSetups, fetchedSetupsForHost)
  const previousProjectById = new Map(previous.projects.map((project) => [project.id, project]))
  const reposById = getReposById(repos)
  const currentRepoIds = new Set(repos.map((repo) => repo.id))
  const projectHasHost = (project: Project, setups: readonly ProjectHostSetup[]): boolean =>
    getProjectHostIds(project, setups, repos).has(hostId)
  const projectHasCurrentOwnerOutsideHost = (project: Project): boolean =>
    [...getExplicitProjectHostIds(project, projectHostSetups, repos)].some(
      (ownerHostId) => ownerHostId !== hostId
    )
  const fetchedProjects = fetched.projects
    .filter((project) => {
      const previousProject = previousProjectById.get(project.id)
      // Why: repo-derived compatibility projects include every known host.
      // A one-host refresh should only reconcile that host or prune its stale ownership.
      return (
        projectHasHost(project, fetched.projectHostSetups) ||
        (previousProject ? projectHasHost(previousProject, previous.projectHostSetups) : false)
      )
    })
    .map((project) => {
      const previousProject = previousProjectById.get(project.id)
      return previousProject
        ? mergePreviousProjectMetadata(previousProject, project, reposById, hostId)
        : projectWithCurrentSourceRepoIds(project, currentRepoIds)
    })
  const fetchedProjectIds = new Set(fetchedProjects.map((project) => project.id))
  const preservedProjects = previous.projects.filter(
    (project) =>
      !fetchedProjectIds.has(project.id) &&
      (!getProjectHostIds(project, previous.projectHostSetups, repos).has(hostId) ||
        projectHasCurrentOwnerOutsideHost(project))
  )
  return {
    projects: mergeProjectCompatibilityProjects(
      preservedProjects.map((project) => {
        const sourceRepoIds = getSourceRepoIdsOutsideHost(project, reposById, hostId)
        return sourceRepoIds.length === project.sourceRepoIds.length
          ? project
          : { ...project, sourceRepoIds }
      }),
      fetchedProjects
    ),
    projectHostSetups
  }
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
  const fetchedWithProjectGroups = applyInheritedProjectGroups(previous, fetched)
  const fetchedIdentities = new Set(fetchedWithProjectGroups.map(getRepoHostIdentity))
  const preserved = previous.filter((repo) => {
    const existingHostId = getRepoExecutionHostId(repo)
    return existingHostId !== hostId || fetchedIdentities.has(getRepoHostIdentity(repo))
  })
  const merged = [...preserved]
  const indexByIdentity = new Map(merged.map((repo, index) => [getRepoHostIdentity(repo), index]))
  for (const repo of fetchedWithProjectGroups) {
    const identity = getRepoHostIdentity(repo)
    const existingIndex = indexByIdentity.get(identity)
    if (existingIndex === undefined) {
      indexByIdentity.set(identity, merged.length)
      merged.push(repo)
      continue
    }
    merged[existingIndex] = repo
  }
  return reconcileFetchedRepos(previous, merged)
}

function applyInheritedProjectGroups(previous: readonly Repo[], fetched: readonly Repo[]): Repo[] {
  const projectGroupIdByProject = new Map<string, string | null>()
  for (const repo of previous) {
    const projectGroupId =
      repo.projectGroupId === undefined ? undefined : (repo.projectGroupId ?? null)
    if (projectGroupId === undefined) {
      continue
    }
    const projectId = getProjectIdentityKey(repo)
    if (projectId.startsWith('repo:')) {
      continue
    }
    if (!projectGroupIdByProject.has(projectId)) {
      projectGroupIdByProject.set(projectId, projectGroupId)
    }
  }
  if (projectGroupIdByProject.size === 0) {
    return [...fetched]
  }
  return fetched.map((repo) => {
    if (repo.projectGroupId !== undefined) {
      return repo
    }
    const inheritedProjectGroupId = projectGroupIdByProject.get(getProjectIdentityKey(repo))
    if (inheritedProjectGroupId === undefined) {
      return repo
    }
    // Why: project groups are a local organization affordance. Runtime copies
    // of the same canonical project should appear in the user's existing group.
    return { ...repo, projectGroupId: inheritedProjectGroupId }
  })
}

function mergeProjectCompatibilityForHostRepoChange({
  previous,
  nextRepos,
  hostId
}: {
  previous: Pick<RepoSlice, 'projects' | 'projectHostSetups'>
  nextRepos: readonly Repo[]
  hostId: string
}): Pick<RepoSlice, 'projects' | 'projectHostSetups'> {
  return mergeFetchedProjectCompatibilityForHost({
    previous,
    fetched: projectCompatibilityFromRepos(nextRepos),
    repos: nextRepos,
    hostId
  })
}

function getProjectGroupHostId(group: Pick<ProjectGroup, 'connectionId' | 'executionHostId'>) {
  if (group.executionHostId) {
    return group.executionHostId
  }
  return group.connectionId ? toSshExecutionHostId(group.connectionId) : LOCAL_EXECUTION_HOST_ID
}

function mergeFetchedProjectGroupsForHost(
  previous: readonly ProjectGroup[],
  fetched: ProjectGroup[],
  hostId: string
): ProjectGroup[] {
  const fetchedIds = new Set(fetched.map((group) => group.id))
  const preserved = previous.filter((group) => {
    const existingHostId = getProjectGroupHostId(group)
    return existingHostId !== hostId || fetchedIds.has(group.id)
  })
  return mergeById(preserved, fetched)
}

function mergeFetchedFolderWorkspacesForHost({
  previous,
  fetched,
  projectGroups,
  hostId
}: {
  previous: readonly FolderWorkspace[]
  fetched: FolderWorkspace[]
  projectGroups: readonly ProjectGroup[]
  hostId: string
}): FolderWorkspace[] {
  const fetchedIds = new Set(fetched.map((workspace) => workspace.id))
  const projectGroupHostIds = new Map(
    projectGroups.map((group) => [group.id, getProjectGroupHostId(group)])
  )
  const preserved = previous.filter((workspace) => {
    const existingHostId = projectGroupHostIds.get(workspace.projectGroupId)
    return existingHostId === undefined || existingHostId !== hostId || fetchedIds.has(workspace.id)
  })
  return mergeById(preserved, fetched)
}

type FetchedRepoCatalog = {
  repos: Repo[]
  projectHostSetupCompatibility: ProjectHostSetupProjection
  hostId: ReturnType<typeof getRuntimeTargetHostId>
}

type FetchedProjectGroupCatalog = {
  projectGroups: ProjectGroup[]
  hostId: ReturnType<typeof getRuntimeTargetHostId>
}

type FetchedFolderWorkspaceCatalog = {
  folderWorkspaces: FolderWorkspace[]
  hostId: ReturnType<typeof getRuntimeTargetHostId>
}

async function fetchRepoCatalogForTarget(
  target: ReturnType<typeof getActiveRuntimeTarget>
): Promise<FetchedRepoCatalog> {
  const fetchedRepos =
    target.kind === 'local'
      ? await window.api.repos.list()
      : (
          await callRuntimeRpc<{ repos: Repo[] }>(target, 'repo.list', undefined, {
            timeoutMs: 15_000,
            reuseRecentCompatibilityFailure: true
          })
        ).repos
  const repos = fetchedRepos.map((repo) => repoWithFetchedOwner(repo, target))
  return {
    repos,
    projectHostSetupCompatibility: await fetchProjectHostSetupCompatibility(target, repos),
    hostId: getRuntimeTargetHostId(target)
  }
}

function mergeFetchedRepoCatalog(
  catalog: FetchedRepoCatalog,
  currentRepos: readonly Repo[]
): {
  repos: Repo[]
  projectHostSetupCompatibility: ProjectHostSetupProjection
  hostId: ReturnType<typeof getRuntimeTargetHostId>
} {
  const repos = mergeFetchedReposForHost(currentRepos, catalog.repos, catalog.hostId)
  return {
    repos,
    projectHostSetupCompatibility: catalog.projectHostSetupCompatibility,
    hostId: catalog.hostId
  }
}

function reconcileSupersededSshRepos(
  repos: readonly Repo[],
  state: Pick<AppState, 'pendingSshRepoReadoptions'>
): SshRepoReconciliation {
  return reconcileReadoptedSshRepoRows(repos, state.pendingSshRepoReadoptions)
}

function filterSetupsForPrunedRepoRows(
  setups: readonly ProjectHostSetup[],
  mergedRepos: readonly Repo[],
  reconciledRepos: readonly Repo[]
): ProjectHostSetup[] {
  const survivingOwners = new Set(
    reconciledRepos.map((repo) => `${getRepoExecutionHostId(repo)}:${repo.id}`)
  )
  const prunedOwners = new Set(
    mergedRepos
      .filter((repo) => !survivingOwners.has(`${getRepoExecutionHostId(repo)}:${repo.id}`))
      .map((repo) => `${getRepoExecutionHostId(repo)}:${repo.id}`)
  )
  if (prunedOwners.size === 0) {
    return [...setups]
  }
  return setups.filter(
    (setup) => !setup.repoId || !prunedOwners.has(`${setup.hostId}:${setup.repoId}`)
  )
}

function reconcileReadoptedSshWorktreeState(
  state: Pick<AppState, 'worktreesByRepo' | 'detectedWorktreesByRepo' | 'sortEpoch'>,
  readoptions: readonly SshRepoReadoption[]
): Pick<AppState, 'worktreesByRepo' | 'detectedWorktreesByRepo' | 'sortEpoch'> {
  const worktreesByRepo = reconcileReadoptedSshWorktreesByRepo(state.worktreesByRepo, readoptions)
  const detectedRows = Object.fromEntries(
    Object.entries(state.detectedWorktreesByRepo).map(([repoId, result]) => [
      repoId,
      result.worktrees
    ])
  )
  const reconciledDetectedRows = reconcileReadoptedSshWorktreesByRepo(detectedRows, readoptions)
  const detectedWorktreesByRepo =
    reconciledDetectedRows === detectedRows
      ? state.detectedWorktreesByRepo
      : Object.fromEntries(
          Object.entries(state.detectedWorktreesByRepo).map(([repoId, result]) => [
            repoId,
            { ...result, worktrees: reconciledDetectedRows[repoId] }
          ])
        )
  return {
    worktreesByRepo,
    detectedWorktreesByRepo,
    sortEpoch: worktreesByRepo === state.worktreesByRepo ? state.sortEpoch : state.sortEpoch + 1
  }
}

function projectCompatibilityForReconciledRepos(
  repos: readonly Repo[],
  fetched: ProjectHostSetupProjection
): Pick<RepoSlice, 'projects' | 'projectHostSetups'> {
  return mergeProjectHostSetupCompatibility(projectCompatibilityFromRepos(repos), fetched)
}

function filterTrustedOrcaHooksToValidRepos(
  trust: AppState['trustedOrcaHooks'],
  validRepoIds: Set<string>
): AppState['trustedOrcaHooks'] {
  const next: AppState['trustedOrcaHooks'] = {}
  for (const [repoId, entry] of Object.entries(trust)) {
    if (validRepoIds.has(repoId)) {
      next[repoId] = entry
    }
  }
  return next
}

function clearRestoredFolderWorkspaceSessionOwners(
  owners: AppState['restoredRuntimeHostIdByWorkspaceSessionKey'] | undefined,
  state: Pick<AppState, 'folderWorkspaces' | 'projectGroups'>
): AppState['restoredRuntimeHostIdByWorkspaceSessionKey'] {
  const next: AppState['restoredRuntimeHostIdByWorkspaceSessionKey'] = {}
  for (const [key, hostId] of Object.entries(owners ?? {})) {
    const scope = parseWorkspaceKey(key)
    if (scope?.type !== 'folder') {
      next[key] = hostId
      continue
    }
    const workspace = state.folderWorkspaces.find((entry) => entry.id === scope.folderWorkspaceId)
    if (workspace && !state.projectGroups.some((group) => group.id === workspace.projectGroupId)) {
      // Why: folder workspace ownership is resolved through its project group.
      // If that catalog is still missing, keep the restored host owner so a
      // session write before the next retry does not move runtime tabs local.
      next[key] = hostId
    }
  }
  return next
}

async function fetchProjectGroupCatalogForTarget(
  target: ReturnType<typeof getActiveRuntimeTarget>
): Promise<FetchedProjectGroupCatalog> {
  const fetchedGroups =
    target.kind === 'local'
      ? await window.api.projectGroups.list()
      : (
          await callRuntimeRpc<{ groups: ProjectGroup[] }>(target, 'projectGroup.list', undefined, {
            timeoutMs: 15_000,
            reuseRecentCompatibilityFailure: true
          })
        ).groups
  return {
    projectGroups: fetchedGroups.map((group) => projectGroupWithFetchedOwner(group, target)),
    hostId: getRuntimeTargetHostId(target)
  }
}

function mergeFetchedProjectGroupCatalog(
  catalog: FetchedProjectGroupCatalog,
  currentProjectGroups: readonly ProjectGroup[]
): { projectGroups: ProjectGroup[]; hostId: ReturnType<typeof getRuntimeTargetHostId> } {
  return {
    projectGroups: mergeFetchedProjectGroupsForHost(
      currentProjectGroups,
      catalog.projectGroups,
      catalog.hostId
    ),
    hostId: catalog.hostId
  }
}

async function fetchProjectGroupsForTarget(
  target: ReturnType<typeof getActiveRuntimeTarget>,
  currentProjectGroups: readonly ProjectGroup[]
): Promise<{ projectGroups: ProjectGroup[]; hostId: ReturnType<typeof getRuntimeTargetHostId> }> {
  return mergeFetchedProjectGroupCatalog(
    await fetchProjectGroupCatalogForTarget(target),
    currentProjectGroups
  )
}

async function fetchFolderWorkspaceCatalogForTarget(
  target: ReturnType<typeof getActiveRuntimeTarget>
): Promise<FetchedFolderWorkspaceCatalog> {
  const fetchedFolderWorkspaces =
    target.kind === 'local'
      ? await window.api.folderWorkspaces.list()
      : (
          await callRuntimeRpc<{ folderWorkspaces: FolderWorkspace[] }>(
            target,
            'folderWorkspace.list',
            undefined,
            { timeoutMs: 15_000, reuseRecentCompatibilityFailure: true }
          )
        ).folderWorkspaces
  return {
    folderWorkspaces: fetchedFolderWorkspaces,
    hostId: getRuntimeTargetHostId(target)
  }
}

function mergeFetchedFolderWorkspaceCatalog(
  catalog: FetchedFolderWorkspaceCatalog,
  currentFolderWorkspaces: readonly FolderWorkspace[],
  projectGroups: readonly ProjectGroup[]
): {
  folderWorkspaces: FolderWorkspace[]
  hostId: ReturnType<typeof getRuntimeTargetHostId>
} {
  return {
    folderWorkspaces: mergeFetchedFolderWorkspacesForHost({
      previous: currentFolderWorkspaces,
      fetched: catalog.folderWorkspaces,
      projectGroups,
      hostId: catalog.hostId
    }),
    hostId: catalog.hostId
  }
}

async function fetchFolderWorkspacesForTarget(
  target: ReturnType<typeof getActiveRuntimeTarget>,
  currentFolderWorkspaces: readonly FolderWorkspace[],
  projectGroups: readonly ProjectGroup[]
): Promise<{
  folderWorkspaces: FolderWorkspace[]
  hostId: ReturnType<typeof getRuntimeTargetHostId>
}> {
  return mergeFetchedFolderWorkspaceCatalog(
    await fetchFolderWorkspaceCatalogForTarget(target),
    currentFolderWorkspaces,
    projectGroups
  )
}

async function listRuntimeEnvironmentsForAllHostLoad(): Promise<{ id: string }[]> {
  try {
    return (await window.api.runtimeEnvironments.list()) ?? []
  } catch (err) {
    console.warn('Failed to list runtime environments for all-host load:', err)
    return []
  }
}

function settingsForRepoOwner(
  state: Pick<AppState, 'repos' | 'settings'>,
  repoId: string,
  hostId?: ExecutionHostId
) {
  const repo = findRepoForHost(state.repos, repoId, { settings: state.settings, hostId })
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
  if (
    (parsed?.kind === 'local' || parsed?.kind === 'ssh') &&
    state.settings?.activeRuntimeEnvironmentId
  ) {
    return { ...state.settings, activeRuntimeEnvironmentId: null }
  }
  return state.settings
}

function getFolderWorkspacePathStatusScopeKey(request: FolderWorkspacePathStatusRequest): string {
  if (request.scope === 'project-group') {
    return `project-group:${request.projectGroupId}`
  }
  if (request.scope === 'path') {
    return `path:${request.connectionId ?? ''}:${request.path}`
  }
  return `folder-workspace:${request.folderWorkspaceId}`
}

function getRuntimeTargetCachePrefix(
  settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined
): string {
  const target = getActiveRuntimeTarget(settings)
  return target.kind === 'local' ? 'local' : `environment:${target.environmentId}`
}

type FolderWorkspacePathStatusRouteOptions = { runtimeEnvironmentId?: string | null }
type AddRepoPathRouteOptions = { runtimeEnvironmentId?: string | null }

function getFolderWorkspacePathStatusRouteSettings(
  options: FolderWorkspacePathStatusRouteOptions | undefined,
  fallbackSettings: GlobalSettings | null
): Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined {
  return options && 'runtimeEnvironmentId' in options
    ? { activeRuntimeEnvironmentId: options.runtimeEnvironmentId ?? null }
    : fallbackSettings
}

function getAddRepoPathRouteSettings(
  options: AddRepoPathRouteOptions | undefined,
  fallbackSettings: GlobalSettings | null
): Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined {
  return options && 'runtimeEnvironmentId' in options
    ? { activeRuntimeEnvironmentId: options.runtimeEnvironmentId ?? null }
    : fallbackSettings
}

function getRuntimeEnvironmentDisplayName(state: AppState, environmentId: string): string {
  const environment = state.runtimeEnvironments.find((entry) => entry.id === environmentId)
  return environment?.name || environmentId
}

async function fetchRuntimeAddProjectPathStatus(args: {
  target: Extract<ReturnType<typeof getActiveRuntimeTarget>, { kind: 'environment' }>
  path: string
}): Promise<FolderWorkspacePathStatus | null> {
  await assertRuntimeEnvironmentCapability(
    args.target.environmentId,
    FOLDER_WORKSPACE_PATH_STATUS_RUNTIME_CAPABILITY,
    translate(
      'auto.store.slices.repos.2975400634',
      'Update Orca server to open non-Git folders on this runtime.'
    ),
    15_000
  )
  try {
    const { status } = await callRuntimeRpc<{ status: FolderWorkspacePathStatus }>(
      args.target,
      'folderWorkspace.getPathStatus',
      { scope: 'path', path: args.path },
      { timeoutMs: 15_000 }
    )
    return status
  } catch (err) {
    console.warn('Failed to check runtime folder path status:', err)
    return null
  }
}

function getFolderWorkspaceStatusRequestSnapshot(
  state: Pick<AppState, 'projectGroups' | 'folderWorkspaces' | 'repos' | 'sshConnectionStates'>,
  request: FolderWorkspacePathStatusRequest
): string | null {
  if (request.scope === 'path') {
    const candidateRepos = state.repos.filter((repo) =>
      isPathInsideOrEqual(request.path, repo.path)
    )
    const relevantConnectionIds = new Set<string>()
    if (request.connectionId) {
      relevantConnectionIds.add(request.connectionId)
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
    return [request.path, '', request.connectionId ?? '', sshFingerprint, repoFingerprint].join(
      '\0'
    )
  }

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
  // Monotonic sequence so an overlapping fetchRepos can drop its own stale result (#7020).
  reposFetchGeneration: number
  pendingSshRepoReadoptions: SshRepoReadoption[]
  recordSshRepoReadoptions: (readoptions: SshRepoReadoption[]) => void
  fetchRepos: () => Promise<void>
  fetchReposForAllHosts: (options?: AllHostCatalogFetchOptions) => Promise<void>
  fetchRuntimeEnvironmentRepos: (environmentId: string) => Promise<Repo[]>
  fetchProjectGroups: () => Promise<void>
  fetchProjectGroupsForAllHosts: (options?: AllHostCatalogFetchOptions) => Promise<void>
  fetchFolderWorkspaces: () => Promise<void>
  fetchFolderWorkspacesForAllHosts: (options?: AllHostCatalogFetchOptions) => Promise<void>
  addRepo: () => Promise<Repo | null>
  addRepoPath: (
    path: string,
    kind?: 'git' | 'folder',
    options?: AddRepoPathRouteOptions
  ) => Promise<Repo | null>
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
  addNonGitFolder: (path: string, options?: AddRepoPathRouteOptions) => Promise<Repo | null>
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
  createFolderWorkspace: (
    args: {
      projectGroupId: string
      name?: string
      folderPath?: string | null
      connectionId?: string | null
      linkedTask?: FolderWorkspace['linkedTask']
      createdWithAgent?: FolderWorkspace['createdWithAgent']
      pendingFirstAgentMessageRename?: boolean
    },
    options?: FolderWorkspacePathStatusRouteOptions
  ) => Promise<FolderWorkspace | null>
  getFolderWorkspacePathStatusCacheKey: (
    request: FolderWorkspacePathStatusRequest,
    options?: FolderWorkspacePathStatusRouteOptions
  ) => string
  getFreshFolderWorkspacePathStatus: (
    request: FolderWorkspacePathStatusRequest,
    options?: FolderWorkspacePathStatusRouteOptions
  ) => FolderWorkspacePathStatus | null
  fetchFolderWorkspacePathStatus: (
    request: FolderWorkspacePathStatusRequest,
    options?: { force?: boolean } & FolderWorkspacePathStatusRouteOptions
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
  // options.hostId disambiguates which host's row to remove when the same repo
  // id exists on multiple hosts; without it the focused host is assumed.
  removeProject: (projectId: string, options?: { hostId?: ExecutionHostId }) => Promise<void>
  updateProject: (projectId: string, updates: ProjectUpdate) => Promise<boolean>
  // options.hostId targets a specific host's repo row + RPC target when the same
  // repo id exists on multiple hosts; without it the focused host is assumed.
  updateRepo: (
    projectId: string,
    updates: RepoUpdate,
    options?: { hostId?: ExecutionHostId }
  ) => Promise<boolean>
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
  reposFetchGeneration: 0,
  pendingSshRepoReadoptions: [],

  recordSshRepoReadoptions: (readoptions) =>
    set((s) => {
      const pendingSshRepoReadoptions = mergeSshRepoReadoptions(
        s.pendingSshRepoReadoptions,
        readoptions
      )
      const reconciliation = reconcileReadoptedSshRepoRows(s.repos, pendingSshRepoReadoptions)
      const repos = reconciliation.repos
      const worktreeState = reconcileReadoptedSshWorktreeState(s, pendingSshRepoReadoptions)
      const projectHostSetups = filterSetupsForPrunedRepoRows(s.projectHostSetups, s.repos, repos)
      const compatibility = mergeProjectHostSetupCompatibility(
        projectCompatibilityFromRepos(repos),
        {
          projects: s.projects,
          setups: projectHostSetups
        }
      )
      return {
        repos,
        pendingSshRepoReadoptions: reconciliation.pendingReadoptions,
        ...worktreeState,
        ...compatibility
      }
    }),

  fetchRepos: async () => {
    // Why: overlapping repos:changed fetches can resolve out of order; an earlier
    // one must not overwrite a newer result and resurrect deleted projects (#7020).
    let generation = 0
    set((s) => {
      generation = s.reposFetchGeneration + 1
      return { reposFetchGeneration: generation }
    })
    try {
      const target = getActiveRuntimeTarget(get().settings)
      const catalog = await fetchRepoCatalogForTarget(target)
      // A newer fetchRepos superseded us while we awaited — drop this stale result.
      if (get().reposFetchGeneration !== generation) {
        return
      }
      let finalizedHostRepos: Repo[] = []
      set((s) => {
        // Why: after re-adoption re-points a repo onto a re-added SSH target, the
        // per-host merge leaves the stale row on the old (removed) target id — a
        // ghost a terminal pane can bind to and fail with "SSH target not found".
        // Drop rows on unknown SSH targets that a live-host sibling supersedes.
        const result = mergeFetchedRepoCatalog(catalog, s.repos)
        const reconciliation = reconcileSupersededSshRepos(result.repos, s)
        const prunedRepos = reconciliation.repos
        const validRepoIds = new Set(prunedRepos.map((repo) => repo.id))
        const projectCompatibility = projectCompatibilityForReconciledRepos(
          prunedRepos,
          catalog.projectHostSetupCompatibility
        )
        const mergedProjectCompatibility = mergeFetchedProjectCompatibilityForHost({
          previous: {
            projects: s.projects,
            projectHostSetups: filterSetupsForPrunedRepoRows(
              s.projectHostSetups,
              result.repos,
              prunedRepos
            )
          },
          fetched: projectCompatibility,
          repos: prunedRepos,
          hostId: result.hostId
        })
        finalizedHostRepos = prunedRepos.filter(
          (repo) => getRepoExecutionHostId(repo) === result.hostId
        )
        return {
          repos: prunedRepos,
          pendingSshRepoReadoptions: reconciliation.pendingReadoptions,
          ...reconcileReadoptedSshWorktreeState(s, s.pendingSshRepoReadoptions),
          ...mergedProjectCompatibility,
          folderWorkspacePathStatuses: {},
          activeRepoId: s.activeRepoId && validRepoIds.has(s.activeRepoId) ? s.activeRepoId : null,
          filterRepoIds: s.filterRepoIds.filter((projectId) => validRepoIds.has(projectId)),
          setupScriptPromptDismissedRepoIds: filterSetupScriptPromptDismissalsToValidRepos(
            s.setupScriptPromptDismissedRepoIds,
            validRepoIds
          )
        }
      })
      scheduleSafeAutoForkSync(get, finalizedHostRepos)
    } catch (err) {
      console.error('Failed to fetch repos:', err)
    }
  },

  fetchRuntimeEnvironmentRepos: async (environmentId) => {
    try {
      const target = { kind: 'environment' as const, environmentId }
      const catalog = await fetchRepoCatalogForTarget(target)
      let finalizedHostRepos: Repo[] = []
      set((s) => {
        const result = mergeFetchedRepoCatalog(catalog, s.repos)
        const reconciliation = reconcileSupersededSshRepos(result.repos, s)
        const finalizedRepos = reconciliation.repos
        const validRepoIds = new Set(finalizedRepos.map((repo) => repo.id))
        const projectCompatibility = projectCompatibilityForReconciledRepos(
          finalizedRepos,
          catalog.projectHostSetupCompatibility
        )
        const mergedProjectCompatibility = mergeFetchedProjectCompatibilityForHost({
          previous: {
            projects: s.projects,
            projectHostSetups: filterSetupsForPrunedRepoRows(
              s.projectHostSetups,
              result.repos,
              finalizedRepos
            )
          },
          fetched: projectCompatibility,
          repos: finalizedRepos,
          hostId: result.hostId
        })
        finalizedHostRepos = finalizedRepos.filter(
          (repo) => getRepoExecutionHostId(repo) === result.hostId
        )
        return {
          repos: finalizedRepos,
          pendingSshRepoReadoptions: reconciliation.pendingReadoptions,
          ...reconcileReadoptedSshWorktreeState(s, s.pendingSshRepoReadoptions),
          ...mergedProjectCompatibility,
          activeRepoId: s.activeRepoId && validRepoIds.has(s.activeRepoId) ? s.activeRepoId : null,
          filterRepoIds: s.filterRepoIds.filter((projectId) => validRepoIds.has(projectId)),
          setupScriptPromptDismissedRepoIds: filterSetupScriptPromptDismissalsToValidRepos(
            s.setupScriptPromptDismissedRepoIds,
            validRepoIds
          )
        }
      })
      scheduleSafeAutoForkSync(get, finalizedHostRepos)
      return finalizedHostRepos
    } catch (err) {
      console.error(`Failed to fetch repos for runtime environment ${environmentId}:`, err)
      return []
    }
  },

  fetchReposForAllHosts: async (options) => {
    let generation = 0
    set((s) => {
      generation = s.reposFetchGeneration + 1
      return { reposFetchGeneration: generation }
    })
    // Why: a cold start that restores a remote workspace re-activates that
    // remote runtime environment, and fetching only the active host hides every
    // other host's repos (notably all local repos), which reads as "my projects
    // vanished". Load local + every configured runtime environment so the
    // sidebar "All hosts" scope shows them together regardless of which
    // environment is active. Each host fails soft: an unreachable/disconnected
    // host is skipped without blocking the others.
    const applyCatalog = (catalog: FetchedRepoCatalog): void => {
      // Why: repos:changed can start another all-host refresh while this one is
      // in flight. Never let the older catalog resurrect a migrated SSH owner.
      if (get().reposFetchGeneration !== generation) {
        return
      }
      let hostRepos: Repo[] = []
      set((s) => {
        const result = mergeFetchedRepoCatalog(catalog, s.repos)
        const reconciliation = reconcileSupersededSshRepos(result.repos, s)
        const finalizedRepos = reconciliation.repos
        const projectCompatibility = projectCompatibilityForReconciledRepos(
          finalizedRepos,
          catalog.projectHostSetupCompatibility
        )
        const mergedProjectCompatibility = mergeFetchedProjectCompatibilityForHost({
          previous: {
            projects: s.projects,
            projectHostSetups: filterSetupsForPrunedRepoRows(
              s.projectHostSetups,
              result.repos,
              finalizedRepos
            )
          },
          fetched: projectCompatibility,
          repos: finalizedRepos,
          hostId: result.hostId
        })
        hostRepos = finalizedRepos.filter((repo) => getRepoExecutionHostId(repo) === result.hostId)
        return {
          repos: finalizedRepos,
          pendingSshRepoReadoptions: reconciliation.pendingReadoptions,
          ...reconcileReadoptedSshWorktreeState(s, s.pendingSshRepoReadoptions),
          ...mergedProjectCompatibility,
          folderWorkspacePathStatuses: {},
          activeRepoId: s.activeRepoId,
          filterRepoIds: s.filterRepoIds,
          setupScriptPromptDismissedRepoIds: s.setupScriptPromptDismissedRepoIds
        }
      })
      // Why: preserve the safe-auto fork sync that fetchRepos /
      // fetchRuntimeEnvironmentRepos schedule after merging each host, so
      // cold-start (which now routes through here) keeps updating safe-auto forks.
      scheduleSafeAutoForkSync(get, hostRepos)
    }
    const validateRepoScopedUi = (): void => {
      set((s) => {
        const validRepoIds = new Set(s.repos.map((repo) => repo.id))
        return {
          activeRepoId: s.activeRepoId && validRepoIds.has(s.activeRepoId) ? s.activeRepoId : null,
          filterRepoIds: s.filterRepoIds.filter((projectId) => validRepoIds.has(projectId)),
          setupScriptPromptDismissedRepoIds: filterSetupScriptPromptDismissalsToValidRepos(
            s.setupScriptPromptDismissedRepoIds,
            validRepoIds
          ),
          trustedOrcaHooks: filterTrustedOrcaHooksToValidRepos(s.trustedOrcaHooks, validRepoIds)
        }
      })
    }

    // Local first so local repos are present even if a remote fetch stalls.
    let failed = false
    try {
      applyCatalog(await fetchRepoCatalogForTarget({ kind: 'local' }))
    } catch (err) {
      failed = true
      console.error('Failed to fetch local repos for all-host load:', err)
    }
    if (get().reposFetchGeneration !== generation) {
      return
    }
    if (options?.remoteHosts === 'skip') {
      return
    }

    const environments = await listRuntimeEnvironmentsForAllHostLoad()
    // Why: unreachable remotes can spend the full connect timeout; merge each
    // resolved host through the state updater so parallel loads do not clobber.
    await Promise.all(
      environments.map(async (environment) => {
        try {
          applyCatalog(
            await fetchRepoCatalogForTarget({
              kind: 'environment',
              environmentId: environment.id
            })
          )
        } catch (err) {
          failed = true
          console.warn(`Skipped repos for runtime environment ${environment.id}:`, err)
        }
      })
    )
    // Why: first-paint startup intentionally loads only local repos before
    // remotes answer. Validate repo-scoped UI only once every configured host has
    // answered; otherwise an offline runtime would erase its saved filters.
    if (!failed && get().reposFetchGeneration === generation) {
      validateRepoScopedUi()
    }
  },

  fetchProjectGroups: async () => {
    try {
      const target = getActiveRuntimeTarget(get().settings)
      const { projectGroups } = await fetchProjectGroupsForTarget(target, [])
      set({
        projectGroups,
        folderWorkspacePathStatuses: {}
      })
    } catch (err) {
      console.error('Failed to fetch project groups:', err)
    }
  },

  fetchProjectGroupsForAllHosts: async (options) => {
    // Why: startup renders an all-host sidebar; replacing groups with only the
    // active host would leave repos from other hosts visible but ungrouped.
    const applyCatalog = (catalog: FetchedProjectGroupCatalog): void => {
      set((s) => ({
        projectGroups: mergeFetchedProjectGroupCatalog(catalog, s.projectGroups).projectGroups,
        folderWorkspacePathStatuses: {}
      }))
    }

    try {
      applyCatalog(await fetchProjectGroupCatalogForTarget({ kind: 'local' }))
    } catch (err) {
      console.error('Failed to fetch local project groups for all-host load:', err)
    }
    if (options?.remoteHosts === 'skip') {
      return
    }

    const environments = await listRuntimeEnvironmentsForAllHostLoad()
    await Promise.all(
      environments.map(async (environment) => {
        try {
          applyCatalog(
            await fetchProjectGroupCatalogForTarget({
              kind: 'environment',
              environmentId: environment.id
            })
          )
        } catch (err) {
          console.warn(`Skipped project groups for runtime environment ${environment.id}:`, err)
        }
      })
    )
  },

  fetchFolderWorkspaces: async () => {
    try {
      const target = getActiveRuntimeTarget(get().settings)
      const { folderWorkspaces } = await fetchFolderWorkspacesForTarget(
        target,
        [],
        get().projectGroups
      )
      set({ folderWorkspaces, folderWorkspacePathStatuses: {} })
    } catch (err) {
      console.error('Failed to fetch folder workspaces:', err)
    }
  },

  fetchFolderWorkspacesForAllHosts: async (options) => {
    // Why: folder workspaces are owned through their project groups, so startup
    // must fetch groups first and then merge each host's folder slice.
    const applyCatalog = (catalog: FetchedFolderWorkspaceCatalog): void => {
      set((s) => ({
        folderWorkspaces: mergeFetchedFolderWorkspaceCatalog(
          catalog,
          s.folderWorkspaces,
          s.projectGroups
        ).folderWorkspaces,
        folderWorkspacePathStatuses: {}
      }))
    }

    let failed = false
    try {
      applyCatalog(await fetchFolderWorkspaceCatalogForTarget({ kind: 'local' }))
    } catch (err) {
      failed = true
      console.error('Failed to fetch local folder workspaces for all-host load:', err)
    }
    if (options?.remoteHosts === 'skip') {
      return
    }

    const environments = await listRuntimeEnvironmentsForAllHostLoad()
    await Promise.all(
      environments.map(async (environment) => {
        try {
          applyCatalog(
            await fetchFolderWorkspaceCatalogForTarget({
              kind: 'environment',
              environmentId: environment.id
            })
          )
        } catch (err) {
          failed = true
          console.warn(`Skipped folder workspaces for runtime environment ${environment.id}:`, err)
        }
      })
    )
    if (!failed) {
      set((s) => ({
        restoredRuntimeHostIdByWorkspaceSessionKey: clearRestoredFolderWorkspaceSessionOwners(
          s.restoredRuntimeHostIdByWorkspaceSessionKey,
          s
        )
      }))
    }
  },

  getFolderWorkspacePathStatusCacheKey: (request, options) =>
    `${getRuntimeTargetCachePrefix(
      getFolderWorkspacePathStatusRouteSettings(options, get().settings)
    )}:${getFolderWorkspacePathStatusScopeKey(request)}`,

  getFreshFolderWorkspacePathStatus: (request, options) => {
    const state = get()
    const cacheKey = get().getFolderWorkspacePathStatusCacheKey(request, options)
    const cached = state.folderWorkspacePathStatuses[cacheKey]
    const requestSnapshot = getFolderWorkspacePathStatusRequestSnapshotForRead(state, request)
    return getFreshFolderWorkspacePathStatusFromCache({ entry: cached, requestSnapshot })
  },

  fetchFolderWorkspacePathStatus: async (request, options) => {
    const cacheKey = get().getFolderWorkspacePathStatusCacheKey(request, options)
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
      const target = getActiveRuntimeTarget(
        getFolderWorkspacePathStatusRouteSettings(options, get().settings)
      )
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
      const ownedGroup = projectGroupWithFetchedOwner(group, target)
      set((s) => ({
        projectGroups: [...s.projectGroups, ownedGroup],
        folderWorkspacePathStatuses: {}
      }))
      return ownedGroup
    } catch (err) {
      console.error('Failed to create project group:', err)
      return null
    }
  },

  createFolderWorkspace: async (args, options) => {
    try {
      const target = getActiveRuntimeTarget(
        getFolderWorkspacePathStatusRouteSettings(options, get().settings)
      )
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
      throw new Error(`${title}. ${description}`)
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
      const ownedGroup = projectGroupWithFetchedOwner(updated, target)
      set((s) => ({
        projectGroups: s.projectGroups.map((group) => (group.id === groupId ? ownedGroup : group)),
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
      if (!findRepoForHost(get().repos, projectId, { settings: get().settings })) {
        return false
      }
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
      const movedHostId = getRepoExecutionHostId(ownedMoved)
      set((s) => {
        const nextRepos = s.repos.map((repo) =>
          repoMatchesHostIdentity(repo, projectId, movedHostId) ? ownedMoved : repo
        )
        return {
          repos: nextRepos,
          ...mergeProjectCompatibilityForHostRepoChange({
            previous: { projects: s.projects, projectHostSetups: s.projectHostSetups },
            nextRepos,
            hostId: movedHostId
          }),
          folderWorkspacePathStatuses: {}
        }
      })
      return true
    } catch (err) {
      console.error('Failed to move repo to group:', err)
      return false
    }
  },

  addRepoPath: async (path, kind = 'git', options) => {
    try {
      const target = getActiveRuntimeTarget(getAddRepoPathRouteSettings(options, get().settings))
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
        if (target.kind !== 'local') {
          const status = await fetchRuntimeAddProjectPathStatus({ target, path })
          if (status?.exists !== true) {
            const hostName = getRuntimeEnvironmentDisplayName(get(), target.environmentId)
            toast.error(
              translate(
                'auto.store.slices.repos.3be0f7df04',
                'Cannot open folder on selected runtime'
              ),
              {
                description: translate(
                  'auto.store.slices.repos.15cf5319ec',
                  '{{path}} was checked on {{hostName}}, but that host did not report a usable folder.',
                  { path, hostName }
                ),
                duration: ERROR_TOAST_DURATION
              }
            )
            return null
          }
        }
        // Why: folder mode is a capability downgrade, not a silent fallback.
        // Show an in-app confirmation dialog so users understand that worktrees,
        // SCM, PRs, and checks will be unavailable for this root. The dialog's
        // OK handler calls addNonGitFolder to complete the flow.
        const { openModal } = get()
        openModal('confirm-non-git-folder', {
          folderPath: path,
          ...(target.kind === 'environment' ? { runtimeEnvironmentId: target.environmentId } : {})
        })
        return null
      }
      repo = repoWithFetchedOwner(repo, target)
      const repoIdentity = getRepoHostIdentity(repo)
      const alreadyAdded = get().repos.some((r) => getRepoHostIdentity(r) === repoIdentity)
      if (alreadyAdded) {
        get().clearOrcaHookTrustForRepo(repo.id)
      }
      set((s) => {
        if (s.repos.some((r) => getRepoHostIdentity(r) === repoIdentity)) {
          return s
        }
        const nextRepos = [...s.repos, repo]
        const hostId = getRepoExecutionHostId(repo)
        return {
          repos: nextRepos,
          ...mergeProjectCompatibilityForHostRepoChange({
            previous: { projects: s.projects, projectHostSetups: s.projectHostSetups },
            nextRepos,
            hostId
          }),
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
        // Why: the design requires the cross-profile advisory for SSH-added
        // projects too — the presence lookup already keys on connection/host.
        await warnIfProjectKnownInAnotherProfile(repo, get().activeOrcaProfileId)
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
      const repoHostId = getRepoExecutionHostId(repo)
      const setup = setupWithFetchedOwner(result.setup, target)
      set((s) => {
        const nextRepos = s.repos.some((entry) =>
          repoMatchesHostIdentity(entry, repo.id, repoHostId)
        )
          ? s.repos.map((entry) =>
              repoMatchesHostIdentity(entry, repo.id, repoHostId) ? repo : entry
            )
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
      const repoHostId = repo ? getRepoExecutionHostId(repo) : null
      set((s) => ({
        repos: repo
          ? s.repos.some((entry) => repoMatchesHostIdentity(entry, repo.id, repoHostId!))
            ? s.repos.map((entry) =>
                repoMatchesHostIdentity(entry, repo.id, repoHostId!) ? repo : entry
              )
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
      const repoHostId = repo ? getRepoExecutionHostId(repo) : null
      set((s) => {
        const projectHostSetups = s.projectHostSetups.filter(
          (setup) => setup.id !== result.setup.id
        )
        const repos =
          repo && repoHostId
            ? s.repos.filter((entry) => !repoMatchesHostIdentity(entry, repo.id, repoHostId))
            : s.repos
        const projects =
          repo && !projectHostSetups.some((setup) => setup.projectId === result.project.id)
            ? s.projects.filter((project) => project.id !== result.project.id)
            : s.projects
        const survivingRepoIds = new Set(repos.map((r) => r.id))
        const removedRepoIds = s.repos.filter((r) => !survivingRepoIds.has(r.id)).map((r) => r.id)
        return {
          repos,
          projects,
          projectHostSetups,
          ...omitSparsePresetsForRepos(s, removedRepoIds)
        }
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

  addNonGitFolder: async (path, options) => {
    try {
      const hadProjectBeforeAdd = get().repos.length > 0
      const repo = await get().addRepoPath(path, 'folder', options)
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

  removeProject: async (projectId, options) => {
    try {
      // Why: pass an explicit hostId (e.g. when removing an SSH host's root repo)
      // so a duplicate id across hosts resolves to the intended row instead of
      // falling back to the focused host.
      const ownerRepo = findRepoForHost(get().repos, projectId, {
        settings: get().settings,
        hostId: options?.hostId
      })
      if (!ownerRepo) {
        return
      }
      const ownerHostId = getRepoExecutionHostId(ownerRepo)
      // Why: an SSH-mode per-workspace-env's workspace is the repo's main worktree, so deleting it
      // routes here (project removal) rather than through removeWorktree. Tear down the backing
      // ephemeral runtime (Docker/VM + hidden SSH target) first so it doesn't leak when the project
      // is removed. Matches on the repo's runtime-owned connectionId and its known worktree ids.
      if (isRuntimeOwnedSshTargetId(ownerRepo.connectionId)) {
        await cleanupEphemeralVmRuntimesForDeleted({
          workspaceIds: getKnownRepoWorktreeIds(get(), projectId, ownerHostId),
          runtimeOwnedSshTargetIds: [ownerRepo.connectionId as string]
        })
      }
      // Why: derive the runtime target from the owner's own settings, passing the
      // explicit options.hostId so a duplicate repo id across hosts resolves to the
      // intended row. settingsForRepoOwner clears the focused runtime for SSH/local
      // owners (routing local) and pins runtime owners to their environment, so an
      // SSH host removal never routes repo.rm to the focused runtime.
      const target = getActiveRuntimeTarget(settingsForRepoOwner(get(), projectId, options?.hostId))
      // Why: the same repo id can exist on multiple hosts (local + an SSH target,
      // or a re-added SSH target). Main's repos:remove is repo-id-only and would
      // delete every host's row. Scope the local-side removal to the owning host
      // so a cross-host duplicate id keeps its other rows.
      const idExistsOnOtherHost = get().repos.some(
        (repo) => repo.id === projectId && getRepoExecutionHostId(repo) !== ownerHostId
      )
      await (target.kind === 'local'
        ? idExistsOnOtherHost
          ? window.api.repos.removeForHost({ repoId: projectId, hostId: ownerHostId })
          : window.api.repos.remove({ repoId: projectId })
        : callRuntimeRpc(target, 'repo.rm', { repo: projectId }, { timeoutMs: 15_000 }))

      get().clearOrcaHookTrustForRepo(projectId)
      const repoPath = get().repos.find((repo) =>
        repoMatchesHostIdentity(repo, projectId, ownerHostId)
      )?.path
      get().evictGitHubRepoCaches(projectId, repoPath)
      const { clearRepoSlugCacheEntry } = await import('../../lib/repo-slug-index')
      clearRepoSlugCacheEntry(projectId)

      // Kill PTYs for all worktrees belonging to this repo
      const worktreeIds = getKnownRepoWorktreeIds(get(), projectId, ownerHostId)
      const killedTabIds = new Set<string>()
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
            if (!ptyId.startsWith('remote:')) {
              window.api.pty.kill(ptyId)
            }
          }
        }
      }

      // Why: route project removal through the canonical per-worktree purge so all
      // ~30 worktree-scoped maps are evicted. removeProject previously hand-deleted
      // only a handful (tabs/layouts/ptys), leaking the rest (unified tabs, groups,
      // git status, browser, everActivated, …) per worktree of every removed repo.
      // Runs before the repo-scoped set() below so the purge still sees tabsByWorktree.
      get().purgeWorktreeTerminalState(worktreeIds)

      set((s) => {
        const nextWorktrees = { ...s.worktreesByRepo }
        const remainingWorktrees = (nextWorktrees[projectId] ?? []).filter(
          (worktree) => !worktreeBelongsToHost(worktree, ownerHostId)
        )
        if (remainingWorktrees.length > 0) {
          nextWorktrees[projectId] = remainingWorktrees
        } else {
          delete nextWorktrees[projectId]
        }
        const nextDetectedWorktrees = { ...s.detectedWorktreesByRepo }
        const detected = nextDetectedWorktrees[projectId]
        if (detected) {
          const remainingDetected = detected.worktrees.filter(
            (worktree) => !worktreeBelongsToHost(worktree, ownerHostId)
          )
          if (remainingDetected.length > 0) {
            nextDetectedWorktrees[projectId] = { ...detected, worktrees: remainingDetected }
          } else {
            delete nextDetectedWorktrees[projectId]
          }
        }
        const nextTabs = { ...s.tabsByWorktree }
        const nextLayouts = { ...s.terminalLayoutsByTabId }
        const nextPtyIdsByTabId = { ...s.ptyIdsByTabId }
        const nextRuntimePaneTitlesByTabId = { ...s.runtimePaneTitlesByTabId }
        for (const wId of worktreeIds) {
          delete nextTabs[wId]
        }
        for (const tabId of killedTabIds) {
          delete nextLayouts[tabId]
          delete nextPtyIdsByTabId[tabId]
          delete nextRuntimePaneTitlesByTabId[tabId]
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
        const nextRepos = s.repos.filter((r) => !repoMatchesHostIdentity(r, projectId, ownerHostId))
        // Why: when no sibling host still owns this repo id, drop every persisted
        // timestamp for the repo's worktrees — including unhydrated SSH/remote ones
        // absent from worktreeIdSet, which pruneLastVisitedTimestamps would otherwise
        // defer forever as "not yet hydrated" after the repo is gone. When a duplicate
        // id remains on another host, stay host-scoped via worktreeIdSet.
        const repoIdFullyRemoved = !nextRepos.some((r) => r.id === projectId)
        let nextLastVisitedAtByWorktreeId = s.lastVisitedAtByWorktreeId
        for (const id of Object.keys(s.lastVisitedAtByWorktreeId)) {
          if (
            worktreeIdSet.has(id) ||
            (repoIdFullyRemoved && getRepoIdFromWorktreeId(id) === projectId)
          ) {
            if (nextLastVisitedAtByWorktreeId === s.lastVisitedAtByWorktreeId) {
              nextLastVisitedAtByWorktreeId = { ...s.lastVisitedAtByWorktreeId }
            }
            delete nextLastVisitedAtByWorktreeId[id]
          }
        }
        const survivingRepoIds = new Set(nextRepos.map((r) => r.id))
        const removedRepoIds = s.repos.filter((r) => !survivingRepoIds.has(r.id)).map((r) => r.id)
        return {
          repos: nextRepos,
          // Why: drop the removed repos' sparse-preset maps so they don't outlive
          // the repo for the renderer's whole session.
          ...omitSparsePresetsForRepos(s, removedRepoIds),
          ...mergeProjectCompatibilityForHostRepoChange({
            previous: { projects: s.projects, projectHostSetups: s.projectHostSetups },
            nextRepos,
            hostId: ownerHostId
          }),
          activeRepoId: s.activeRepoId === projectId ? null : s.activeRepoId,
          filterRepoIds: s.filterRepoIds.filter((id) => id !== projectId),
          worktreesByRepo: nextWorktrees,
          detectedWorktreesByRepo: nextDetectedWorktrees,
          tabsByWorktree: nextTabs,
          ptyIdsByTabId: nextPtyIdsByTabId,
          runtimePaneTitlesByTabId: nextRuntimePaneTitlesByTabId,
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

  updateProject: async (projectId, updates) => {
    try {
      const target = getProjectUpdateRuntimeTarget(get(), projectId)
      const updatedProject =
        target.kind === 'local'
          ? await window.api.projects.update({ projectId, updates })
          : (
              await callRuntimeRpc<{ project: Project }>(
                target,
                'project.update',
                { projectId, updates },
                { timeoutMs: 15_000 }
              )
            ).project
      if (!updatedProject) {
        return false
      }
      const runtimePreferenceChanged = 'localWindowsRuntimePreference' in updates
      set((state) => ({
        projects: state.projects.map((project) =>
          project.id === projectId
            ? mergeUpdatedProjectCompatibilityProject(project, updatedProject, updates)
            : project
        ),
        folderWorkspacePathStatuses: {}
      }))
      if (runtimePreferenceChanged) {
        get().clearLocalDetectedAgents()
        notifyInstalledAgentSkillsChanged()
      }
      return true
    } catch (err) {
      console.error('Failed to update project:', err)
      return false
    }
  },

  updateRepo: async (projectId, updates, options) => {
    const updateRepoChains = getRepoUpdateChains(get)
    // Why: pass options.hostId so a duplicate repo id across hosts resolves to the
    // intended row instead of findRepoForHost's settings-focused fallback.
    const ownerRepo = findRepoForHost(get().repos, projectId, {
      settings: get().settings,
      hostId: options?.hostId
    })
    if (!ownerRepo) {
      return false
    }
    // Why: an explicit hostId is authoritative — treat it as an explicit host so
    // routing goes to that host's target (local IPC or its runtime RPC) rather
    // than the currently-focused runtime, which is the same-id/self-pair case.
    const ownerHasExplicitHost = Boolean(
      options?.hostId || ownerRepo.executionHostId?.trim() || ownerRepo.connectionId?.trim()
    )
    const explicitOwnerHostId = getRepoExecutionHostId(ownerRepo)
    const ownerTarget = ownerHasExplicitHost
      ? getProjectSetupRuntimeTarget(explicitOwnerHostId)
      : getActiveRuntimeTarget(settingsForRepoOwner(get(), projectId))
    const ownerHostId = ownerHasExplicitHost
      ? explicitOwnerHostId
      : getRuntimeTargetHostId(ownerTarget)
    const updateChainKey = getRepoHostIdentityForParts(projectId, ownerHostId)
    const applyRepoUpdate = async () => {
      try {
        const sanitizedUpdates = sanitizeRepoUpdate(updates)
        const target = ownerTarget
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
            const matchesOwner = ownerHasExplicitHost
              ? repoMatchesHostIdentity(r, projectId, ownerHostId)
              : repoMatchesHostIdentity(r, projectId, ownerHostId) || r === ownerRepo
            if (!matchesOwner) {
              return r
            }
            if (updatedRepo) {
              return repoWithFetchedOwner(updatedRepo, target)
            }
            let mergedRepo: Repo = r
            const {
              sourceControlAi,
              externalWorktreeDiscoverySuppressedAt,
              ...updatesWithoutClearSentinels
            } = sanitizedUpdates
            mergedRepo = { ...mergedRepo, ...updatesWithoutClearSentinels }
            if (sourceControlAi === null) {
              const { sourceControlAi: _sourceControlAi, ...repoWithoutSourceControlAi } =
                mergedRepo
              mergedRepo = repoWithoutSourceControlAi
            } else if (sourceControlAi !== undefined) {
              mergedRepo = { ...mergedRepo, sourceControlAi }
            }
            if (externalWorktreeDiscoverySuppressedAt === null) {
              const {
                externalWorktreeDiscoverySuppressedAt: _suppressedAt,
                ...repoWithoutSuppression
              } = mergedRepo
              mergedRepo = repoWithoutSuppression
            } else if (externalWorktreeDiscoverySuppressedAt !== undefined) {
              mergedRepo = { ...mergedRepo, externalWorktreeDiscoverySuppressedAt }
            }
            return mergedRepo
          })
          return {
            repos: nextRepos,
            ...mergeProjectCompatibilityForHostRepoChange({
              previous: { projects: s.projects, projectHostSetups: s.projectHostSetups },
              nextRepos,
              hostId: ownerHostId
            }),
            folderWorkspacePathStatuses: {}
          }
        })
        return true
      } catch (err) {
        console.error('Failed to update repo:', err)
        return false
      }
    }
    const previous = updateRepoChains.get(updateChainKey)
    // Why: repo settings are persisted as full nested values. Preserve call
    // order per repo so a slower IPC/RPC response cannot overwrite newer state.
    const next = previous
      ? previous.catch(() => undefined).then(applyRepoUpdate)
      : applyRepoUpdate()
    updateRepoChains.set(updateChainKey, next)
    const cleanup = () => {
      if (updateRepoChains.get(updateChainKey) === next) {
        updateRepoChains.delete(updateChainKey)
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
    const remainingById = new Map<string, { repos: Repo[]; nextIndex: number }>()
    for (const repo of previous) {
      const existing = remainingById.get(repo.id)
      if (existing) {
        existing.repos.push(repo)
      } else {
        remainingById.set(repo.id, { repos: [repo], nextIndex: 0 })
      }
    }
    const next: Repo[] = []
    for (const id of orderedIds) {
      const remaining = remainingById.get(id)
      const repo = remaining?.repos[remaining.nextIndex]
      if (remaining) {
        remaining.nextIndex += 1
      }
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
        await get().fetchReposForAllHosts()
      }
    } catch (err) {
      console.error('Failed to reorder repos:', err)
      await get().fetchReposForAllHosts()
    }
  }
})
