import {
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  toRuntimeExecutionHostId,
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
import type { WorktreeRuntimeOwnerState } from './worktree-runtime-owner'

/**
 * Host for a workspace that names no owner of its own. Why: a workspace on a
 * remote `orca serve` machine carries no connectionId — it is local *to that
 * server*, not to this client — so defaulting to LOCAL routes its operations to
 * the client's own daemon, which cannot see the path. When a runtime is active
 * it owns anything unclaimed; without one, LOCAL is still the only host there is.
 */
function getUnownedWorkspaceHost(state: WorktreeRuntimeOwnerState): ExecutionHostId {
  const activeRuntimeId = state.settings?.activeRuntimeEnvironmentId?.trim()
  return activeRuntimeId ? toRuntimeExecutionHostId(activeRuntimeId) : LOCAL_EXECUTION_HOST_ID
}

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
  return folder && (group || preferredHostId)
    ? (preferredHostId ?? getUnownedWorkspaceHost(state))
    : null
}

/**
 * Resolves a host only when hydrated ownership proves it. Why: a restored SSH
 * worktree can temporarily collide with a local repo row during catalog load.
 */
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
  const explicitRepoHost = parseExecutionHostId(repo.executionHostId)
  if (explicitRepoHost) {
    return explicitRepoHost.id
  }
  return repo.connectionId?.trim()
    ? toSshExecutionHostId(repo.connectionId)
    : getUnownedWorkspaceHost(state)
}
