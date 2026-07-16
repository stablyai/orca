import {
  getRepoExecutionHostId,
  parseExecutionHostId,
  toSshExecutionHostId
} from '../../../shared/execution-host'
import type { ExecutionHostId, ParsedExecutionHost } from '../../../shared/execution-host'
import type {
  FolderWorkspace,
  GlobalSettings,
  ProjectGroup,
  Repo,
  Worktree
} from '../../../shared/types'
import { folderWorkspaceKey, parseWorkspaceKey } from '../../../shared/workspace-scope'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
import { getRepoIdFromWorktreeId } from '@/store/slices/worktree-helpers'
import {
  findIndexedFolderWorkspaceOwner,
  findIndexedProjectGroupOwner,
  findIndexedRepoOwner as findRepoRecord,
  findIndexedWorktreeOwner as findWorktreeRecord
} from './worktree-runtime-owner-index'

type RuntimeExecutionHost = Extract<ParsedExecutionHost, { kind: 'runtime' }>

export type WorktreeRuntimeOwnerState = {
  repos?: readonly Pick<Repo, 'id' | 'connectionId' | 'executionHostId'>[]
  settings?: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null
  worktreesByRepo?: Record<string, readonly Pick<Worktree, 'id' | 'repoId' | 'hostId'>[]>
  folderWorkspaces?: readonly Pick<FolderWorkspace, 'id' | 'projectGroupId' | 'connectionId'>[]
  projectGroups?: readonly Pick<ProjectGroup, 'id' | 'connectionId' | 'executionHostId'>[]
  restoredRuntimeHostIdByWorkspaceSessionKey?: Record<string, ExecutionHostId>
}

function findFolderProjectGroup(
  state: WorktreeRuntimeOwnerState,
  folderWorkspaceId: string
): Pick<ProjectGroup, 'id' | 'connectionId' | 'executionHostId'> | null {
  const folderWorkspace = findFolderWorkspace(state, folderWorkspaceId)
  if (!folderWorkspace) {
    return null
  }
  return findIndexedProjectGroupOwner(state.projectGroups, folderWorkspace.projectGroupId)
}

function findFolderWorkspace(
  state: WorktreeRuntimeOwnerState,
  folderWorkspaceId: string
): Pick<FolderWorkspace, 'id' | 'projectGroupId' | 'connectionId'> | null {
  return findIndexedFolderWorkspaceOwner(state.folderWorkspaces, folderWorkspaceId)
}

function getRuntimeEnvironmentIdForFolderWorkspace(
  state: WorktreeRuntimeOwnerState,
  folderWorkspaceId: string
): string | null {
  const folderWorkspace = findFolderWorkspace(state, folderWorkspaceId)
  const projectGroup = findFolderProjectGroup(state, folderWorkspaceId)
  const parsed = parseExecutionHostId(projectGroup?.executionHostId)
  if (parsed?.kind === 'runtime') {
    return parsed.environmentId
  }
  if (
    parsed?.kind === 'local' ||
    parsed?.kind === 'ssh' ||
    folderWorkspace?.connectionId?.trim() ||
    projectGroup?.connectionId?.trim()
  ) {
    return null
  }
  const restoredRuntimeHost = getRestoredRuntimeHostForFolderWorkspace(state, folderWorkspaceId)
  if (restoredRuntimeHost) {
    return restoredRuntimeHost.environmentId
  }
  return state.settings?.activeRuntimeEnvironmentId?.trim() || null
}

function getRestoredRuntimeHostForFolderWorkspace(
  state: WorktreeRuntimeOwnerState,
  folderWorkspaceId: string
): RuntimeExecutionHost | null {
  // Why: runtime folder catalogs load after session hydration; the saved
  // per-host session partition is the only owner evidence during that gap.
  const workspaceKey = folderWorkspaceKey(folderWorkspaceId)
  const parsed = parseExecutionHostId(
    state.restoredRuntimeHostIdByWorkspaceSessionKey?.[workspaceKey]
  )
  return parsed?.kind === 'runtime' ? parsed : null
}

function getExplicitRuntimeEnvironmentIdFromHost(
  executionHostId: string | null | undefined
): string | null {
  const parsed = parseExecutionHostId(executionHostId)
  return parsed?.kind === 'runtime' ? parsed.environmentId : null
}

function getRuntimeEnvironmentIdFromWorktreeHost(
  hostId: string | null | undefined
): string | null | undefined {
  if (!hostId?.trim()) {
    return undefined
  }
  return getExplicitRuntimeEnvironmentIdFromHost(hostId)
}

function getExecutionHostIdFromWorktreeHost(
  hostId: string | null | undefined
): ExecutionHostId | null {
  return parseExecutionHostId(hostId)?.id ?? null
}

function getExplicitRuntimeEnvironmentIdForFolderWorkspace(
  state: WorktreeRuntimeOwnerState,
  folderWorkspaceId: string
): string | null {
  const folderWorkspace = findFolderWorkspace(state, folderWorkspaceId)
  const projectGroup = findFolderProjectGroup(state, folderWorkspaceId)
  const parsed = parseExecutionHostId(projectGroup?.executionHostId)
  if (parsed) {
    return parsed.kind === 'runtime' ? parsed.environmentId : null
  }
  if (folderWorkspace?.connectionId?.trim() || projectGroup?.connectionId?.trim()) {
    return null
  }
  return getRestoredRuntimeHostForFolderWorkspace(state, folderWorkspaceId)?.environmentId ?? null
}

function getExecutionHostIdForFolderWorkspace(
  state: WorktreeRuntimeOwnerState,
  folderWorkspaceId: string
): ExecutionHostId {
  const folderWorkspace = findFolderWorkspace(state, folderWorkspaceId)
  const projectGroup = findFolderProjectGroup(state, folderWorkspaceId)
  const parsed = parseExecutionHostId(projectGroup?.executionHostId)
  if (parsed) {
    return parsed.id
  }
  const connectionId = folderWorkspace?.connectionId?.trim() || projectGroup?.connectionId?.trim()
  if (connectionId) {
    return toSshExecutionHostId(connectionId)
  }
  const restoredRuntimeHost = getRestoredRuntimeHostForFolderWorkspace(state, folderWorkspaceId)
  if (restoredRuntimeHost) {
    return restoredRuntimeHost.id
  }
  const environmentId = state.settings?.activeRuntimeEnvironmentId?.trim()
  return environmentId ? `runtime:${encodeURIComponent(environmentId)}` : 'local'
}

export function getRuntimeEnvironmentIdForWorktree(
  state: WorktreeRuntimeOwnerState,
  worktreeId: string | null | undefined
): string | null {
  if (!worktreeId) {
    return null
  }
  if (worktreeId === FLOATING_TERMINAL_WORKTREE_ID) {
    return null
  }
  const workspaceScope = parseWorkspaceKey(worktreeId)
  if (workspaceScope?.type === 'folder') {
    return getRuntimeEnvironmentIdForFolderWorkspace(state, workspaceScope.folderWorkspaceId)
  }
  const worktree = findWorktreeRecord(state.worktreesByRepo, worktreeId)
  const worktreeRuntimeEnvironmentId = getRuntimeEnvironmentIdFromWorktreeHost(worktree?.hostId)
  if (worktreeRuntimeEnvironmentId !== undefined) {
    // Why: the same repo can exist on local and remote hosts; a concrete
    // worktree host must override the repo-level default owner.
    return worktreeRuntimeEnvironmentId
  }
  const repoId = worktree?.repoId ?? getRepoIdFromWorktreeId(worktreeId)
  const repo = findRepoRecord(state.repos, repoId)
  const hasExplicitOwner = Boolean(repo?.executionHostId?.trim() || repo?.connectionId?.trim())
  if (repo && hasExplicitOwner) {
    const parsed = parseExecutionHostId(getRepoExecutionHostId(repo))
    return parsed?.kind === 'runtime' ? parsed.environmentId : null
  }
  return state.settings?.activeRuntimeEnvironmentId?.trim() || null
}

export function getExplicitRuntimeEnvironmentIdForWorktree(
  state: WorktreeRuntimeOwnerState,
  worktreeId: string | null | undefined
): string | null {
  if (!worktreeId) {
    return null
  }
  const workspaceScope = parseWorkspaceKey(worktreeId)
  if (workspaceScope?.type === 'folder') {
    return getExplicitRuntimeEnvironmentIdForFolderWorkspace(
      state,
      workspaceScope.folderWorkspaceId
    )
  }
  const worktree = findWorktreeRecord(state.worktreesByRepo, worktreeId)
  if (worktree?.hostId) {
    return getExplicitRuntimeEnvironmentIdFromHost(worktree.hostId)
  }
  const repoId = worktree?.repoId ?? getRepoIdFromWorktreeId(worktreeId)
  const repo = findRepoRecord(state.repos, repoId)
  if (!repo) {
    return null
  }
  // Why: session mirroring is expensive; a merely focused runtime must not make
  // legacy/local worktrees look remote-owned.
  return getExplicitRuntimeEnvironmentIdFromHost(getRepoExecutionHostId(repo))
}

export function getRuntimeSessionMirrorEnvironmentIds(state: WorktreeRuntimeOwnerState): string[] {
  const ids = new Set<string>()
  const activeRuntimeEnvironmentId = state.settings?.activeRuntimeEnvironmentId?.trim()
  if (activeRuntimeEnvironmentId) {
    ids.add(activeRuntimeEnvironmentId)
  }
  for (const repo of state.repos ?? []) {
    const environmentId = getExplicitRuntimeEnvironmentIdFromHost(getRepoExecutionHostId(repo))
    if (environmentId) {
      ids.add(environmentId)
    }
  }
  for (const worktrees of Object.values(state.worktreesByRepo ?? {})) {
    for (const worktree of worktrees) {
      const environmentId = getRuntimeEnvironmentIdFromWorktreeHost(worktree.hostId)
      if (environmentId) {
        ids.add(environmentId)
      }
    }
  }
  for (const group of state.projectGroups ?? []) {
    const environmentId = getExplicitRuntimeEnvironmentIdFromHost(group.executionHostId)
    if (environmentId) {
      ids.add(environmentId)
    }
  }
  for (const hostId of Object.values(state.restoredRuntimeHostIdByWorkspaceSessionKey ?? {})) {
    const parsed = parseExecutionHostId(hostId)
    if (parsed?.kind === 'runtime') {
      ids.add(parsed.environmentId)
    }
  }
  return [...ids].sort()
}

export function getExecutionHostIdForWorktree(
  state: WorktreeRuntimeOwnerState,
  worktreeId: string | null | undefined
): ExecutionHostId {
  if (!worktreeId) {
    return 'local'
  }
  if (worktreeId === FLOATING_TERMINAL_WORKTREE_ID) {
    return 'local'
  }
  const workspaceScope = parseWorkspaceKey(worktreeId)
  if (workspaceScope?.type === 'folder') {
    return getExecutionHostIdForFolderWorkspace(state, workspaceScope.folderWorkspaceId)
  }
  const worktree = findWorktreeRecord(state.worktreesByRepo, worktreeId)
  const worktreeHostId = getExecutionHostIdFromWorktreeHost(worktree?.hostId)
  if (worktreeHostId) {
    // Why: per-worktree host ownership is more specific than the repo host
    // default, especially when local and runtime checkouts share a project.
    return worktreeHostId
  }
  const repoId = worktree?.repoId ?? getRepoIdFromWorktreeId(worktreeId)
  const repo = findRepoRecord(state.repos, repoId)
  const hasExplicitOwner = Boolean(repo?.executionHostId?.trim() || repo?.connectionId?.trim())
  if (repo && hasExplicitOwner) {
    return getRepoExecutionHostId(repo)
  }
  const environmentId = state.settings?.activeRuntimeEnvironmentId?.trim()
  return environmentId ? `runtime:${encodeURIComponent(environmentId)}` : 'local'
}

export function getSettingsForWorktreeRuntimeOwner(
  state: WorktreeRuntimeOwnerState,
  worktreeId: string | null | undefined
): Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> {
  return {
    ...state.settings,
    activeRuntimeEnvironmentId: getRuntimeEnvironmentIdForWorktree(state, worktreeId)
  }
}
