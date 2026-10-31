import type { ExecutionHostId } from '../execution-host'
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
  // Append newly discovered hosts even when persisted preferences predate them.
  for (const host of hostOptions) {
    if (seen.has(host.id)) {
      continue
    }
    ordered.push(host)
  }
  return ordered
}

/** The saved order after dragging the rendered hosts; hosts not rendered keep their saved place. */
export function mergeDraggedHostSectionOrder(
  orderedVisibleHostIds: readonly ExecutionHostId[],
  workspaceHostOrder: readonly ExecutionHostId[],
  hostOptionIds: readonly ExecutionHostId[]
): ExecutionHostId[] {
  const visibleHostIds = new Set(orderedVisibleHostIds)
  const knownHostIds = new Set(hostOptionIds)
  const nextOrder: ExecutionHostId[] = [...orderedVisibleHostIds]
  const seen = new Set(nextOrder)
  // Why: dragging only covers rendered hosts; keep non-rendered SSH/runtime hosts in the saved order so they return in place.
  for (const hostId of [...workspaceHostOrder, ...hostOptionIds]) {
    if (!knownHostIds.has(hostId) || visibleHostIds.has(hostId) || seen.has(hostId)) {
      continue
    }
    nextOrder.push(hostId)
    seen.add(hostId)
  }
  return nextOrder
}
