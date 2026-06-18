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
  worktreesByRepo?: Record<string, readonly Pick<Worktree, 'id' | 'repoId'>[]>
  folderWorkspaces?: readonly Pick<FolderWorkspace, 'id' | 'projectGroupId'>[]
  projectGroups?: readonly Pick<ProjectGroup, 'id' | 'connectionId' | 'executionHostId'>[]
}

function findWorktreeRepoId(
  worktreesByRepo: WorktreeRuntimeOwnerState['worktreesByRepo'],
  worktreeId: string
): string | null {
  for (const worktrees of Object.values(worktreesByRepo ?? {})) {
    const match = worktrees.find((worktree) => worktree.id === worktreeId)
    if (match) {
      return match.repoId
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
  const repoId =
    findWorktreeRepoId(state.worktreesByRepo, worktreeId) ?? getRepoIdFromWorktreeId(worktreeId)
  const repo = state.repos?.find((entry) => entry.id === repoId)
  const hasExplicitOwner = Boolean(repo?.executionHostId?.trim() || repo?.connectionId?.trim())
  if (repo && hasExplicitOwner) {
    const parsed = parseExecutionHostId(getRepoExecutionHostId(repo))
    return parsed?.kind === 'runtime' ? parsed.environmentId : null
  }
  return state.settings?.activeRuntimeEnvironmentId?.trim() || null
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
  const repoId =
    findWorktreeRepoId(state.worktreesByRepo, worktreeId) ?? getRepoIdFromWorktreeId(worktreeId)
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
