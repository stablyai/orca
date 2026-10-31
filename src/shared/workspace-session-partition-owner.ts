import {
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  type ExecutionHostId
} from './execution-host'

/** SSH and runtime hosts own their own partitions; local owns legacy workspaceSession.
 * Earlier builds split SSH rows between local and ssh:<targetId>, turning unread rows into replace-session deletions (#12723, #12721, #18173). Adopt stranded rows on read and return them to their owner on write. */
export function workspaceSessionPartitionHostId(
  executionHostId: string | null | undefined
): ExecutionHostId {
  return parseExecutionHostId(executionHostId)?.id ?? LOCAL_EXECUTION_HOST_ID
}
