import { listEphemeralVmRuntimes } from './ephemeral-vm-runtime-store'
import type { EphemeralVmRuntimeRecord } from './ephemeral-vm-runtimes'
import { isRuntimeOwnedSshTargetId } from './execution-host'
import {
  getOrcadSshDeployment,
  isEphemeralVmRuntimeEnvironment,
  type KnownRuntimeEnvironment
} from './remote-runtime/host-catalog/runtime-environments'

/** The live recipe VM serving a runtime environment, if any. */
export function findEnvironmentEphemeralVmRuntime(
  userDataPath: string,
  environment: Pick<KnownRuntimeEnvironment, 'id' | 'source' | 'orcadDeployment'>
): (EphemeralVmRuntimeRecord & { workspaceId: string }) | undefined {
  // Why: only a VM's own environments (paired, or over its runtime-owned SSH target) can be
  // asleep; the VM store read stays off every other call.
  const servedByVm =
    isEphemeralVmRuntimeEnvironment(environment) ||
    isRuntimeOwnedSshTargetId(getOrcadSshDeployment(environment)?.sshTargetId)
  if (!servedByVm) {
    return undefined
  }
  const runtime = listEphemeralVmRuntimes(userDataPath).find(
    (entry) =>
      entry.runtimeEnvironmentId === environment.id &&
      entry.status !== 'cleaned' &&
      entry.status !== 'cleanup_pending'
  )
  return runtime?.workspaceId ? { ...runtime, workspaceId: runtime.workspaceId } : undefined
}

/** A VM in this state has no server to reach until its recipe resumes it. */
export function isEphemeralVmSuspended(runtime: Pick<EphemeralVmRuntimeRecord, 'status'>): boolean {
  return runtime.status === 'suspended' || runtime.status === 'resume_failed'
}
