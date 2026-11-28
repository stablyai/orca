import {
  LOCAL_EXECUTION_HOST_ID,
  normalizeExecutionHostId,
  type ExecutionHostId
} from '../execution-host/execution-host'
import { isPersonWorkspaceKey } from '../workspace/identity/person-workspace-key'

/** Where the host saves its teammates' own workspaces in shared agents' Homes: one session
 *  partition beside the execution hosts' ones, which no window lists, reads or writes. */
export const TEAMMATE_HOMES_SESSION_PARTITION = 'team:homes'

/** A saved workspace session's partition: an execution host's, or the teammates' one. */
export type WorkspaceSessionPartitionId = ExecutionHostId | typeof TEAMMATE_HOMES_SESSION_PARTITION

export function isTeammateHomesSessionPartition(value: string | null | undefined): boolean {
  return value?.trim() === TEAMMATE_HOMES_SESSION_PARTITION
}

export function normalizeWorkspaceSessionPartitionId(
  value: string | null | undefined
): WorkspaceSessionPartitionId | null {
  return isTeammateHomesSessionPartition(value)
    ? TEAMMATE_HOMES_SESSION_PARTITION
    : normalizeExecutionHostId(value)
}

/** The machine a partition's tabs run on. A shared agent's Home is always a local folder
 *  (`confineBotShareFolderRead`), so the teammates' partition runs on this one. */
export function executionHostOfPartition(partition: WorkspaceSessionPartitionId): ExecutionHostId {
  return partition === TEAMMATE_HOMES_SESSION_PARTITION ? LOCAL_EXECUTION_HOST_ID : partition
}

export function isExecutionHostPartition(
  partition: WorkspaceSessionPartitionId
): partition is ExecutionHostId {
  return partition !== TEAMMATE_HOMES_SESSION_PARTITION
}

/** The partition a teammate's own workspace is saved in, whatever host a caller names; null for
 *  every other workspace. */
export function personWorkspacePartition(
  worktreeId: string
): typeof TEAMMATE_HOMES_SESSION_PARTITION | null {
  return isPersonWorkspaceKey(worktreeId) ? TEAMMATE_HOMES_SESSION_PARTITION : null
}

/** Every partition a profile saves, `local` first; the teammates' one too. */
export function savedSessionPartitionIds(
  partitions: object | undefined
): WorkspaceSessionPartitionId[] {
  const ids = new Set<WorkspaceSessionPartitionId>([LOCAL_EXECUTION_HOST_ID])
  for (const key of Object.keys(partitions ?? {})) {
    const id = normalizeWorkspaceSessionPartitionId(key)
    if (id) {
      ids.add(id)
    }
  }
  return [...ids]
}
