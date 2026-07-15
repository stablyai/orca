import {
  LOCAL_EXECUTION_HOST_ID,
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
  findIndexedWorktreeOwner
} from './worktree-runtime-owner-index'
import type { WorktreeRuntimeOwnerState } from './worktree-runtime-owner'

function getResolvedFolderHost(
  state: WorktreeRuntimeOwnerState,
  folderWorkspaceId: string
): ExecutionHostId | null {
  const folder = findIndexedFolderWorkspaceOwner(state.folderWorkspaces, folderWorkspaceId)
  const group = folder
    ? findIndexedProjectGroupOwner(state.projectGroups, folder.projectGroupId)
    : null
  const explicitHost = parseExecutionHostId(group?.executionHostId)
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
  return folder && group ? LOCAL_EXECUTION_HOST_ID : null
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
  const worktree = findIndexedWorktreeOwner(state.worktreesByRepo, worktreeId)
  const worktreeHost = parseExecutionHostId(worktree?.hostId)
  if (worktreeHost) {
    return worktreeHost.id
  }
  if (!worktree) {
    return null
  }
  const repo = findIndexedRepoOwner(state.repos, worktree.repoId)
  if (!repo) {
    return null
  }
  const explicitRepoHost = parseExecutionHostId(repo.executionHostId)
  if (explicitRepoHost) {
    return explicitRepoHost.id
  }
  return repo.connectionId?.trim()
    ? toSshExecutionHostId(repo.connectionId)
    : LOCAL_EXECUTION_HOST_ID
}
