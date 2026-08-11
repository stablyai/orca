import type { Repo } from '../../../shared/types'
import {
  LOCAL_EXECUTION_HOST_ID,
  normalizeExecutionHostId,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import type { WorkspaceRuntimeOwnerProjection } from './workspace-runtime-host-ownership'
import { resolveFolderWorkspaceExecutionHostId } from './folder-workspace-execution-host'

export type HostPersistenceState = {
  repos: readonly Pick<Repo, 'id' | 'connectionId' | 'executionHostId'>[]
  projectGroups?: readonly {
    id: string
    connectionId?: string | null
    executionHostId?: string | null
    runtimeSourceExecutionHostId?: string | null
  }[]
  folderWorkspaces?: readonly {
    id: string
    projectGroupId: string
    connectionId?: string | null
    executionHostId?: ExecutionHostId | null
    runtimeSourceExecutionHostId?: ExecutionHostId | null
  }[]
  worktreesByRepo: Record<string, readonly WorkspaceRuntimeOwnerProjection[]>
  restoredRuntimeHostIdByWorkspaceSessionKey?: Record<string, ExecutionHostId>
  activeWorktreeId?: string | null
  activeWorkspaceExecutionHostId?: ExecutionHostId | null
}

function getRestoredRuntimeHostId(
  owners: Record<string, ExecutionHostId> | undefined,
  key: string
): ExecutionHostId | null {
  const hostId = owners?.[key]
  return hostId && parseExecutionHostId(hostId)?.kind === 'runtime' ? hostId : null
}

function getFolderWorkspaceCatalogHostId(
  state: HostPersistenceState,
  workspace: NonNullable<HostPersistenceState['folderWorkspaces']>[number]
): ExecutionHostId | null {
  const groups = (state.projectGroups ?? []).filter(
    (group) => group.id === workspace.projectGroupId
  )
  const directHostId = resolveFolderWorkspaceExecutionHostId({ folderWorkspace: workspace })
  if (directHostId || groups.length !== 1) {
    return directHostId
  }
  return resolveFolderWorkspaceExecutionHostId({
    folderWorkspace: workspace,
    projectGroup: groups[0]
  })
}

function getSessionPartitionHostId(hostId: ExecutionHostId): ExecutionHostId {
  return parseExecutionHostId(hostId)?.kind === 'runtime' ? hostId : LOCAL_EXECUTION_HOST_ID
}

export function getFolderWorkspaceRuntimeHostId(
  state: HostPersistenceState,
  key: string
): ExecutionHostId {
  const scope = parseWorkspaceKey(key)
  if (scope?.type !== 'folder') {
    return LOCAL_EXECUTION_HOST_ID
  }
  const restoredHostId = getRestoredRuntimeHostId(
    state.restoredRuntimeHostIdByWorkspaceSessionKey,
    key
  )
  const activeHostId =
    state.activeWorktreeId === key
      ? normalizeExecutionHostId(state.activeWorkspaceExecutionHostId)
      : null
  const preferredHostId = activeHostId ?? restoredHostId
  const workspaces = (state.folderWorkspaces ?? []).filter(
    (entry) => entry.id === scope.folderWorkspaceId
  )
  if (workspaces.length === 0) {
    return restoredHostId ?? LOCAL_EXECUTION_HOST_ID
  }
  const hostIds = workspaces
    .map((workspace) => getFolderWorkspaceCatalogHostId(state, workspace))
    .filter((hostId): hostId is ExecutionHostId => hostId !== null)
  if (preferredHostId) {
    const matchingCount = hostIds.filter((hostId) => hostId === preferredHostId).length
    if (matchingCount === 1) {
      return getSessionPartitionHostId(preferredHostId)
    }
    // Why: stale restored ownership must not move a catalog-known sibling into another host partition.
    return LOCAL_EXECUTION_HOST_ID
  }
  const partitions = new Set(hostIds.map(getSessionPartitionHostId))
  return partitions.size === 1
    ? ([...partitions][0] ?? LOCAL_EXECUTION_HOST_ID)
    : LOCAL_EXECUTION_HOST_ID
}
