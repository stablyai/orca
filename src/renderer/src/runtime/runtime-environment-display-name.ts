import {
  getExecutionHostLabel,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'

/**
 * User-facing name for an execution host. `getExecutionHostLabel` falls back to
 * the raw environment id, which is not what the user named the server.
 */
export function getExecutionHostDisplayLabel(
  runtimeEnvironments: readonly { id: string; name?: string | null }[] | null | undefined,
  hostId: ExecutionHostId
): string {
  const parsed = parseExecutionHostId(hostId)
  if (parsed?.kind !== 'runtime') {
    return getExecutionHostLabel(hostId)
  }
  const name = runtimeEnvironments
    ?.find((environment) => environment.id === parsed.environmentId)
    ?.name?.trim()
  return name || getExecutionHostLabel(hostId)
}
