import {
  LOCAL_EXECUTION_HOST_ID,
  normalizeExecutionHostId,
  type ExecutionHostId
} from '../execution-host/execution-host'

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
