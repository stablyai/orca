import {
  getEphemeralVmHostState,
  getExecutionHostVmStateHealth,
  type EphemeralVmHostLifecycle
} from './execution-host-health'
import { normalizeHostPart, toRuntimeExecutionHostId, type ExecutionHostId } from './execution-host'
import type { ExecutionHostRegistryEntry } from './execution-host-registry'

/**
 * A suspended VM's server is unreachable by design, so its transport reads disconnected or
 * error; the VM record says why. Only hosts already in the registry, and not answering, are
 * annotated.
 */
export function applyEphemeralVmHostLifecycles(
  hosts: Map<ExecutionHostId, ExecutionHostRegistryEntry>,
  lifecycles: readonly EphemeralVmHostLifecycle[] | undefined
): void {
  for (const lifecycle of lifecycles ?? []) {
    const environmentId = normalizeHostPart(lifecycle.runtimeEnvironmentId)
    if (!environmentId) {
      continue
    }
    const hostId = toRuntimeExecutionHostId(environmentId)
    const host = hosts.get(hostId)
    const vmState = getEphemeralVmHostState(lifecycle.status, lifecycle.waking)
    // A server that answers is up whatever the record says (resumed outside Orca, or a suspend
    // step that exited 0 without suspending); only an unreachable server takes the VM's state.
    if (!host || !vmState || host.health === 'available') {
      continue
    }
    // Blocked reasons describe a live server; a VM that is not running has none to report.
    const next: ExecutionHostRegistryEntry = {
      ...host,
      health: getExecutionHostVmStateHealth(vmState),
      vmState
    }
    delete next.blockedReason
    hosts.set(hostId, next)
  }
}
