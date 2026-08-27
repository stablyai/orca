import { TERMINAL_PAIRED_PARKING_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'

type PairedRuntimeParkingCapabilityStatuses = ReadonlyMap<
  string,
  { status: { capabilities?: readonly string[] } | null | undefined }
>

type PairedRuntimeParkingEnvironmentIdsCache = {
  statuses: PairedRuntimeParkingCapabilityStatuses
  environmentIds: ReadonlySet<string>
}

let pairedRuntimeParkingEnvironmentIdsCache: PairedRuntimeParkingEnvironmentIdsCache | null = null

function haveSameEnvironmentIds(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  if (left.size !== right.size) {
    return false
  }
  for (const environmentId of left) {
    if (!right.has(environmentId)) {
      return false
    }
  }
  return true
}

export function selectPairedRuntimeParkingEnvironmentIds(
  statuses: PairedRuntimeParkingCapabilityStatuses
): ReadonlySet<string> {
  const cached = pairedRuntimeParkingEnvironmentIdsCache
  if (cached?.statuses === statuses) {
    return cached.environmentIds
  }

  const capable = new Set<string>()
  for (const [environmentId, entry] of statuses) {
    if (entry.status?.capabilities?.includes(TERMINAL_PAIRED_PARKING_RUNTIME_CAPABILITY)) {
      capable.add(environmentId)
    }
  }
  const environmentIds =
    cached && haveSameEnvironmentIds(cached.environmentIds, capable)
      ? cached.environmentIds
      : capable
  pairedRuntimeParkingEnvironmentIdsCache = { statuses, environmentIds }
  return environmentIds
}

export function selectPairedRuntimeParkingEnvironmentIdsFromState(state: {
  runtimeStatusByEnvironmentId: PairedRuntimeParkingCapabilityStatuses
}): ReadonlySet<string> {
  return selectPairedRuntimeParkingEnvironmentIds(state.runtimeStatusByEnvironmentId)
}

export function resetPairedRuntimeParkingEnvironmentIdsCacheForTest(): void {
  pairedRuntimeParkingEnvironmentIdsCache = null
}
