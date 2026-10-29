import {
  LOCAL_EXECUTION_HOST_ID,
  getRepoExecutionHostId,
  parseExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
import { folderWorkspaceKey, parseWorkspaceKey } from '../../../shared/workspace-scope'
import {
  findIndexedFolderWorkspaceOwner,
  findIndexedProjectGroupOwner,
  findIndexedRepoOwner,
  findIndexedRepoOwnerForHost,
  findIndexedWorktreeOwner,
  findIndexedWorktreeOwnerForHost
} from './worktree-runtime-owner-index'
import type { WorktreeRuntimeOwnerState } from './worktree-runtime-owner-state'
import { runtimeRpcTargetForAuthorityKey } from '@/runtime/runtime-client-target'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'

function getResolvedFolderHost(
  state: WorktreeRuntimeOwnerState,
  folderWorkspaceId: string
): ExecutionHostId | null {
  const preferredHostId =
    state.activeWorktreeId === folderWorkspaceKey(folderWorkspaceId)
      ? (state.activeWorkspaceExecutionHostId ?? undefined)
      : undefined
  const folder = findIndexedFolderWorkspaceOwner(
    state.folderWorkspaces,
    folderWorkspaceId,
    preferredHostId
  )
  const group = folder
    ? findIndexedProjectGroupOwner(state.projectGroups, folder.projectGroupId, preferredHostId)
    : null
  const explicitHost = parseExecutionHostId(folder?.executionHostId ?? group?.executionHostId)
  if (explicitHost) {
    return explicitHost.id
  }
  const connectionId = folder?.connectionId?.trim() || group?.connectionId?.trim()
  if (connectionId) {
    return toSshExecutionHostId(connectionId)
  }
  const restoredHost = parseExecutionHostId(
    state.restoredRuntimeHostIdByWorkspaceSessionKey?.[folderWorkspaceKey(folderWorkspaceId)]
  )
  if (restoredHost?.kind === 'runtime') {
    return restoredHost.id
  }
  return folder && (group || preferredHostId) ? (preferredHostId ?? LOCAL_EXECUTION_HOST_ID) : null
}

/** Require hydrated ownership: restored SSH worktrees can collide with local repo rows while catalogs load. */
export function getResolvedExecutionHostIdForWorktree(
  state: WorktreeRuntimeOwnerState,
  worktreeId: string | null | undefined
): ExecutionHostId | null {
  if (!worktreeId) {
    return null
  }
  if (worktreeId === FLOATING_TERMINAL_WORKTREE_ID) {
    return LOCAL_EXECUTION_HOST_ID
  }
  const scope = parseWorkspaceKey(worktreeId)
  if (scope?.type === 'folder') {
    return getResolvedFolderHost(state, scope.folderWorkspaceId)
  }
  const preferredHostId =
    state.activeWorktreeId === worktreeId
      ? (state.activeWorkspaceExecutionHostId ?? undefined)
      : undefined
  const worktree = preferredHostId
    ? findIndexedWorktreeOwnerForHost(state.worktreesByRepo, worktreeId, preferredHostId)
    : findIndexedWorktreeOwner(state.worktreesByRepo, worktreeId)
  const worktreeHost = parseExecutionHostId(worktree?.hostId)
  if (worktreeHost) {
    return worktreeHost.id
  }
  if (!worktree) {
    return null
  }
  const repo = preferredHostId
    ? findIndexedRepoOwnerForHost(state.repos, worktree.repoId, preferredHostId)
    : findIndexedRepoOwner(state.repos, worktree.repoId)
  if (!repo) {
    return null
  }
  return getRepoExecutionHostId(repo)
}

/**
 * RPC target of the focused workspace's owner row; `null` when nothing is focused, ownership is
 * unproven, or the owner has no RPC route (direct SSH). Callers pick their own fallback.
 */
export function getActiveWorkspaceOwnerTarget(
  state: WorktreeRuntimeOwnerState
): RuntimeClientTarget | null {
  // Without paired servers all RPC owners are this app; skip building the owner index.
  if (state.runtimeEnvironmentCatalogHydrated && state.runtimeEnvironments?.length === 0) {
    return null
  }
  const hostId = getResolvedExecutionHostIdForWorktree(state, state.activeWorktreeId)
  return hostId ? runtimeRpcTargetForAuthorityKey(hostId) : null
}
