import { getRepoExecutionHostId, parseExecutionHostId } from '../../../shared/execution-host'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type {
  FolderWorkspace,
  GlobalSettings,
  ProjectGroup,
  Repo,
  Worktree
} from '../../../shared/types'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import { getRepoIdFromWorktreeId } from '@/store/slices/worktree-helpers'

export type WorktreeRuntimeOwnerState = {
  repos?: readonly Pick<Repo, 'id' | 'connectionId' | 'executionHostId'>[]
  settings?: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null
  worktreesByRepo?: Record<string, readonly Pick<Worktree, 'id' | 'repoId' | 'hostId'>[]>
  folderWorkspaces?: readonly Pick<FolderWorkspace, 'id' | 'projectGroupId'>[]
  projectGroups?: readonly Pick<ProjectGroup, 'id' | 'connectionId' | 'executionHostId'>[]
}

function findWorktreeRecord(
  worktreesByRepo: WorktreeRuntimeOwnerState['worktreesByRepo'],
  worktreeId: string
): Pick<Worktree, 'id' | 'repoId' | 'hostId'> | null {
  for (const worktrees of Object.values(worktreesByRepo ?? {})) {
    const match = worktrees.find((worktree) => worktree.id === worktreeId)
    if (match) {
      return match
    }
  }
  return null
}

function findFolderProjectGroup(
  state: WorktreeRuntimeOwnerState,
  folderWorkspaceId: string
): Pick<ProjectGroup, 'id' | 'connectionId' | 'executionHostId'> | null {
  const folderWorkspace = state.folderWorkspaces?.find(
    (workspace) => workspace.id === folderWorkspaceId
  )
  if (!folderWorkspace) {
    return null
  }
  return state.projectGroups?.find((group) => group.id === folderWorkspace.projectGroupId) ?? null
}

function getRuntimeEnvironmentIdForFolderWorkspace(
  state: WorktreeRuntimeOwnerState,
  folderWorkspaceId: string
): string | null {
  const projectGroup = findFolderProjectGroup(state, folderWorkspaceId)
  const parsed = parseExecutionHostId(projectGroup?.executionHostId)
  if (parsed?.kind === 'runtime') {
    return parsed.environmentId
  }
  if (parsed?.kind === 'local' || parsed?.kind === 'ssh' || projectGroup?.connectionId) {
    return null
  }
  return state.settings?.activeRuntimeEnvironmentId?.trim() || null
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
  return getExplicitRuntimeEnvironmentIdFromHost(
    findFolderProjectGroup(state, folderWorkspaceId)?.executionHostId
  )
}

function getExecutionHostIdForFolderWorkspace(
  state: WorktreeRuntimeOwnerState,
  folderWorkspaceId: string
): ExecutionHostId {
  const projectGroup = findFolderProjectGroup(state, folderWorkspaceId)
  const parsed = parseExecutionHostId(projectGroup?.executionHostId)
  if (parsed) {
    return parsed.id
  }
  if (projectGroup?.connectionId) {
    return `ssh:${encodeURIComponent(projectGroup.connectionId)}`
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
  const repo = state.repos?.find((entry) => entry.id === repoId)
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
  const repo = state.repos?.find((entry) => entry.id === repoId)
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
  return [...ids].sort()
}

export function getExecutionHostIdForWorktree(
  state: WorktreeRuntimeOwnerState,
  worktreeId: string | null | undefined
): ExecutionHostId {
  if (!worktreeId) {
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
  const repo = state.repos?.find((entry) => entry.id === repoId)
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
