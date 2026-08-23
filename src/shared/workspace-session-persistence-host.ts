import {
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  type ExecutionHostId
} from './execution-host'

export function getWorkspaceSessionPersistenceHostId(
  executionHostId: ExecutionHostId
): ExecutionHostId {
  const host = parseExecutionHostId(executionHostId)
  return host?.kind === 'runtime' ? host.id : LOCAL_EXECUTION_HOST_ID
}
