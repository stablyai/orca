import { parseExecutionHostId, type ExecutionHostId } from '../../../shared/execution-host'

export type NewWorkspaceRepoAgentHost =
  | { kind: 'local' }
  | { kind: 'ssh'; connectionId: string }
  | { kind: 'runtime'; environmentId: string }

export function resolveNewWorkspaceRepoAgentHost(input: {
  connectionId: string | null | undefined
  executionHostId: ExecutionHostId | null | undefined
  fallbackRuntimeEnvironmentId: string | null | undefined
}): NewWorkspaceRepoAgentHost {
  const explicitHost = parseExecutionHostId(input.executionHostId)
  if (explicitHost?.kind === 'runtime') {
    return { kind: 'runtime', environmentId: explicitHost.environmentId }
  }
  if (explicitHost?.kind === 'ssh') {
    return { kind: 'ssh', connectionId: explicitHost.targetId }
  }
  if (explicitHost?.kind === 'local') {
    return { kind: 'local' }
  }
  const connectionId = input.connectionId?.trim()
  if (connectionId) {
    return { kind: 'ssh', connectionId }
  }
  const runtimeEnvironmentId = input.fallbackRuntimeEnvironmentId?.trim()
  return runtimeEnvironmentId
    ? { kind: 'runtime', environmentId: runtimeEnvironmentId }
    : { kind: 'local' }
}
