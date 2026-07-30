import {
  LOCAL_EXECUTION_HOST_ID,
  normalizeExecutionHostId,
  parseExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'

export function resolveJiraSourceHostId(args: {
  workspaceHostId?: string | null
  groupExecutionHostId?: string | null
  groupConnectionId?: string | null
}): ExecutionHostId {
  const groupHostId =
    normalizeExecutionHostId(args.groupExecutionHostId) ??
    (args.groupConnectionId
      ? toSshExecutionHostId(args.groupConnectionId)
      : LOCAL_EXECUTION_HOST_ID)
  const hostId = normalizeExecutionHostId(args.workspaceHostId) ?? groupHostId
  return parseExecutionHostId(hostId)?.kind === 'ssh' ? LOCAL_EXECUTION_HOST_ID : hostId
}
