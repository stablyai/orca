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
  findIndexedProjectGroupOwner
} from './worktree-runtime-owner-index'
import { selectWorktreesByRepo } from '@/store/workspace-record-selectors'
import { resolveQualifiedWorktreeExecutionOwner } from './qualified-worktree-execution-owner'
import type { WorktreeRuntimeOwnerState } from './worktree-runtime-owner-state'
import { runtimeRpcTargetForAuthorityKey } from '@/runtime/runtime-client-target'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'

export function getResolvedFolderExecutionOwner<
  T extends NonNullable<WorktreeRuntimeOwnerState['folderWorkspaces']>[number]
>(
  state: WorktreeRuntimeOwnerState & { folderWorkspaces?: readonly T[] },
  folderWorkspaceId: string
): { hostId: ExecutionHostId; workspace: T } | null {
  const preferredHostId =
    state.activeWorktreeId === folderWorkspaceKey(folderWorkspaceId)
      ? (state.activeWorkspaceExecutionHostId ?? undefined)
      : undefined
  const folderWorkspaces = state.folderWorkspaces
  const folder =
    findIndexedFolderWorkspaceOwner(folderWorkspaces, folderWorkspaceId, preferredHostId) ??
    findIndexedFolderWorkspaceOwner(folderWorkspaces, folderWorkspaceId)
  if (!folder) {
    return null
  }
  const group = folder
    ? (findIndexedProjectGroupOwner(state.projectGroups, folder.projectGroupId, preferredHostId) ??
      findIndexedProjectGroupOwner(state.projectGroups, folder.projectGroupId))
    : null
  const explicitHost = parseExecutionHostId(folder?.executionHostId ?? group?.executionHostId)
  const connectionId = folder.connectionId?.trim() || group?.connectionId?.trim()
  const restoredHost = parseExecutionHostId(
    state.restoredRuntimeHostIdByWorkspaceSessionKey?.[folderWorkspaceKey(folderWorkspaceId)]
  )
  const hostId =
    explicitHost?.id ??
    (connectionId
      ? toSshExecutionHostId(connectionId)
      : restoredHost?.kind === 'runtime'
        ? restoredHost.id
        : group || preferredHostId
          ? (preferredHostId ?? LOCAL_EXECUTION_HOST_ID)
          : null)
  return hostId && (!preferredHostId || hostId === preferredHostId)
    ? { hostId, workspace: folder }
    : null
}

/** Keep the selected row and inherited host together through runtime/path resolution. */
export function getResolvedWorktreeExecutionOwner<
  T extends NonNullable<WorktreeRuntimeOwnerState['worktreesByRepo']>[string][number]
>(
  state: WorktreeRuntimeOwnerState & { worktreesByRepo?: Record<string, readonly T[]> },
  worktreeId: string
): { hostId: ExecutionHostId; workspace: T } | null {
  const owner = getQualifiedWorktreeOwner<T>(state, worktreeId)
  return owner ? { hostId: owner.physicalHostId, workspace: owner.worktree } : null
}

function getQualifiedWorktreeOwner<
  T extends NonNullable<WorktreeRuntimeOwnerState['worktreesByRepo']>[string][number]
>(
  state: WorktreeRuntimeOwnerState & { worktreesByRepo?: Record<string, readonly T[]> },
  worktreeId: string
) {
  const preferredHostId =
    state.activeWorktreeId === worktreeId
      ? (state.activeWorkspaceExecutionHostId ?? undefined)
      : undefined
  return resolveQualifiedWorktreeExecutionOwner<T>(
    selectWorktreesByRepo(state),
    state.repos,
    worktreeId,
    preferredHostId
  )
}

function restoredFolderRuntimeHost(
  state: WorktreeRuntimeOwnerState,
  key: string
): ExecutionHostId | null {
  const host = parseExecutionHostId(state.restoredRuntimeHostIdByWorkspaceSessionKey?.[key])
  return host?.kind === 'runtime' ? host.id : null
}

function getWorkspaceExecutionHosts(
  state: WorktreeRuntimeOwnerState,
  worktreeId: string | null | undefined
): { hostId: ExecutionHostId; physicalHostId: ExecutionHostId } | null {
  if (!worktreeId) {
    return null
  }
  if (worktreeId === FLOATING_TERMINAL_WORKTREE_ID) {
    return { hostId: LOCAL_EXECUTION_HOST_ID, physicalHostId: LOCAL_EXECUTION_HOST_ID }
  }
  const scope = parseWorkspaceKey(worktreeId)
  if (scope?.type === 'folder') {
    const hostId =
      getResolvedFolderExecutionOwner(state, scope.folderWorkspaceId)?.hostId ??
      restoredFolderRuntimeHost(state, folderWorkspaceKey(scope.folderWorkspaceId))
    return hostId ? { hostId, physicalHostId: hostId } : null
  }
  return getQualifiedWorktreeOwner(state, worktreeId)
}

/** Require hydrated ownership before addressing a workspace operation. */
export function getResolvedExecutionHostIdForWorktree(
  state: WorktreeRuntimeOwnerState,
  worktreeId: string | null | undefined
): ExecutionHostId | null {
  return getWorkspaceExecutionHosts(state, worktreeId)?.hostId ?? null
}

/** Filesystem ownership for unstamped OS paths, independent of the selected operation address. */
export function getResolvedPhysicalExecutionHostIdForWorktree(
  state: WorktreeRuntimeOwnerState,
  worktreeId: string | null | undefined
): ExecutionHostId | null {
  return getWorkspaceExecutionHosts(state, worktreeId)?.physicalHostId ?? null
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
