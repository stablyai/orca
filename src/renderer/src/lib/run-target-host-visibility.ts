import type { ExecutionHostId } from '../../../shared/execution-host'
import type { ExecutionHostRegistryEntry } from '../../../shared/execution-host/execution-host-registry-entry'
import { isEphemeralVmProjectHost } from './project-host-setup-options'

/** Run on never lists per-workspace VMs, so Create waits for a visible host; a VM recipe creates a new VM instead. */
export function needsVisibleRunTargetHost(
  resolution: { status: 'ready'; target: { hostId: ExecutionHostId } } | { status: 'unavailable' },
  hosts: readonly ExecutionHostRegistryEntry[],
  ephemeralVmRecipeId: string | null
): boolean {
  return (
    ephemeralVmRecipeId === null &&
    resolution.status === 'ready' &&
    isEphemeralVmProjectHost(hosts.find((host) => host.id === resolution.target.hostId))
  )
}
