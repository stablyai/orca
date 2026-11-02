import {
  LOCAL_EXECUTION_HOST_ID,
  toRuntimeExecutionHostId,
  type ExecutionHostId
} from './execution-host'

export function checkRunDetailsOwnerScope(
  hostId: ExecutionHostId,
  runtimeEnvironmentId?: string | null
): string | null {
  const runtimeId = runtimeEnvironmentId?.trim()
  const runtimeHostId = runtimeId ? toRuntimeExecutionHostId(runtimeId) : null
  // A paired server and direct SSH connection to the same machine use separate transports.
  const scope = runtimeHostId && runtimeHostId !== hostId ? `${hostId}>${runtimeHostId}` : hostId
  return scope === LOCAL_EXECUTION_HOST_ID ? null : scope
}
