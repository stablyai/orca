import type { EphemeralVmRuntimeRecord } from './ephemeral-vm-runtimes'
import { toRuntimeExecutionHostId, toSshExecutionHostId } from './execution-host'

/** A workspace id alone can name unrelated checkouts on different hosts. */
export function findEphemeralVmWorkspaceOwner(
  runtimes: readonly EphemeralVmRuntimeRecord[],
  workspaceId: string,
  hostId: string
): EphemeralVmRuntimeRecord | undefined {
  const matches = runtimes.filter(
    (runtime) =>
      runtime.workspaceId === workspaceId &&
      ((runtime.runtimeEnvironmentId !== undefined &&
        hostId === toRuntimeExecutionHostId(runtime.runtimeEnvironmentId)) ||
        (runtime.sshTargetId !== undefined && hostId === toSshExecutionHostId(runtime.sshTargetId)))
  )
  if (matches.length > 1) {
    throw new Error(
      'Multiple environment recipes own this workspace. Resolve ownership before deleting.'
    )
  }
  return matches[0]
}
