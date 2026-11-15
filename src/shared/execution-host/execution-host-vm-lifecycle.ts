import {
  getEphemeralVmHostState,
  getExecutionHostVmStateHealth,
  type EphemeralVmHostLifecycle
} from './execution-host-health'
import {
  normalizeHostPart,
  toRuntimeExecutionHostId,
  type ExecutionHostId
} from '../execution-host'
import type {
  ExecutionHostRegistryEntry,
  RuntimeStatusByEnvironmentId
} from './execution-host-registry-entry'

/**
 * A suspended VM's server is unreachable by design, so its transport reads disconnected or
 * error; the VM record says why. Only hosts already in the registry, and not answering, are
 * annotated.
 */
export function applyEphemeralVmHostLifecycles(
  hosts: Map<ExecutionHostId, ExecutionHostRegistryEntry>,
  lifecycles: readonly EphemeralVmHostLifecycle[] | undefined,
  statusByEnvironmentId: RuntimeStatusByEnvironmentId | undefined
): void {
  for (const lifecycle of lifecycles ?? []) {
    const environmentId = normalizeHostPart(lifecycle.runtimeEnvironmentId)
    if (!environmentId) {
      continue
    }
    const hostId = toRuntimeExecutionHostId(environmentId)
    const host = hosts.get(hostId)
    const vmState = getEphemeralVmHostState(lifecycle.status, lifecycle.waking)
    // A server that answers (even one that refuses us) is up whatever the record says: resumed
    // outside Orca, or a suspend step that exited 0 without suspending. Only an unreachable
    // server takes the VM's state.
    const answering =
      host?.health === 'available' ||
      (host?.health === 'blocked' &&
        statusByEnvironmentId?.get(environmentId)?.snapshot?.transport === 'ready')
    if (!host || !vmState || answering) {
      continue
    }
    // A blocked reason kept from before the VM slept describes a server that is not there now.
    const next: ExecutionHostRegistryEntry = {
      ...host,
      health: getExecutionHostVmStateHealth(vmState),
      vmState
    }
    delete next.blockedReason
    hosts.set(hostId, next)
  }
}
