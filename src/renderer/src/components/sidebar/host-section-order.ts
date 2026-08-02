import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { HostSectionOption } from './host-section-rows'

export function orderHostSectionOptions(
  hostOptions: readonly HostSectionOption[],
  workspaceHostOrder: readonly ExecutionHostId[] = []
): HostSectionOption[] {
  if (workspaceHostOrder.length === 0 || hostOptions.length <= 1) {
    return [...hostOptions]
  }
  const hostById = new Map(hostOptions.map((host) => [host.id, host]))
  const ordered: HostSectionOption[] = []
  const seen = new Set<ExecutionHostId>()
  for (const hostId of workspaceHostOrder) {
    const host = hostById.get(hostId)
    if (!host || seen.has(host.id)) {
      continue
    }
    ordered.push(host)
    seen.add(host.id)
  }
  // Why: persisted order is only a preference for hosts the user has seen;
  // newly-discovered SSH/runtime hosts should still appear without needing a
  // migration or explicit reset.
  for (const host of hostOptions) {
    if (seen.has(host.id)) {
      continue
    }
    ordered.push(host)
  }
  return ordered
}
