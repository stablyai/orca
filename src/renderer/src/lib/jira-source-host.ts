import {
  getConnectionExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  normalizeExecutionHostId,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'

export function resolveJiraSourceHostId(args: {
  workspaceHostId?: string | null
  groupExecutionHostId?: string | null
  groupConnectionId?: string | null
}): ExecutionHostId {
  const groupHostId =
    normalizeExecutionHostId(args.groupExecutionHostId) ??
    getConnectionExecutionHostId(args.groupConnectionId)
  const hostId = normalizeExecutionHostId(args.workspaceHostId) ?? groupHostId
  return parseExecutionHostId(hostId)?.kind === 'ssh' ? LOCAL_EXECUTION_HOST_ID : hostId
}
