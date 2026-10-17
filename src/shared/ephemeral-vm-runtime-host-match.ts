import {
  toRuntimeExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId
} from './execution-host'
import type { EphemeralVmRuntimeRecord } from './ephemeral-vm-runtimes'

/** VM records identify their execution host through the environment or managed SSH target. */
export function ephemeralVmMatchesWorkspaceHost(
  runtime: EphemeralVmRuntimeRecord,
  workspaceId: string,
  executionHostId: ExecutionHostId
): boolean {
  return (
    runtime.workspaceId === workspaceId &&
    ((runtime.runtimeEnvironmentId !== undefined &&
      toRuntimeExecutionHostId(runtime.runtimeEnvironmentId) === executionHostId) ||
      (runtime.sshTargetId !== undefined &&
        toSshExecutionHostId(runtime.sshTargetId) === executionHostId))
  )
}
