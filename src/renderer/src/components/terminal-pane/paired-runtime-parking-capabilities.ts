import { TERMINAL_PAIRED_PARKING_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import {
  isRuntimeHostContactRevoked,
  lastVerifiedRuntimeStatus,
  type RuntimeHostStatusSnapshot
} from '../../../../shared/runtime-host-status'

type PairedRuntimeParkingCapability = { capabilities?: readonly string[] }

type PairedRuntimeParkingCapabilityStatuses = ReadonlyMap<
  string,
  {
    status: PairedRuntimeParkingCapability | null | undefined
    snapshot?:
      | ({ status: PairedRuntimeParkingCapability | null } & Pick<
          RuntimeHostStatusSnapshot,
          'verification' | 'retired'
        >)
      | null
  }
>

type PairedRuntimeParkingEnvironmentIdsCache = {
  statuses: PairedRuntimeParkingCapabilityStatuses
  environmentIds: ReadonlySet<string>
}

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

export function createPairedRuntimeParkingEnvironmentIdsSelector() {
  let cache: PairedRuntimeParkingEnvironmentIdsCache | null = null
  return (statuses: PairedRuntimeParkingCapabilityStatuses): ReadonlySet<string> => {
    const cached = cache
    if (cached?.statuses === statuses) {
      return cached.environmentIds
    }

    const capable = new Set<string>()
    for (const [environmentId, entry] of statuses) {
      // Keep last-verified build capabilities across unverifiable probes; a revoked host cannot promise restoration (docs/reference/ssh-execution-boundary.md).
      if (isRuntimeHostContactRevoked(entry)) {
        continue
      }
      const status = lastVerifiedRuntimeStatus<PairedRuntimeParkingCapability>(entry)
      if (status?.capabilities?.includes(TERMINAL_PAIRED_PARKING_RUNTIME_CAPABILITY)) {
        capable.add(environmentId)
      }
    }
    const environmentIds =
      cached && haveSameEnvironmentIds(cached.environmentIds, capable)
        ? cached.environmentIds
        : capable
    cache = { statuses, environmentIds }
    return environmentIds
  }
}

let selectParkingEnvironmentIds = createPairedRuntimeParkingEnvironmentIdsSelector()

export function selectPairedRuntimeParkingEnvironmentIds(
  statuses: PairedRuntimeParkingCapabilityStatuses
): ReadonlySet<string> {
  return selectParkingEnvironmentIds(statuses)
}

export function selectPairedRuntimeParkingEnvironmentIdsFromState(state: {
  runtimeStatusByEnvironmentId: PairedRuntimeParkingCapabilityStatuses
}): ReadonlySet<string> {
  return selectPairedRuntimeParkingEnvironmentIds(state.runtimeStatusByEnvironmentId)
}

export function resetPairedRuntimeParkingEnvironmentIdsCacheForTest(): void {
  selectParkingEnvironmentIds = createPairedRuntimeParkingEnvironmentIdsSelector()
}
