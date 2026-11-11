import '../../../../../../shared/protocol-version'
import { readRecordChanges } from '@/store/keyed-record-change-reads'
import { TERMINAL_PAIRED_PARKING_RUNTIME_CAPABILITY } from '../../../../../../shared/terminal/runtime-policy/terminal-runtime-capabilities'
import {
  isRuntimeHostContactRevoked,
  lastVerifiedRuntimeStatus,
  type RuntimeHostStatusSnapshot
} from '../../../../../../shared/remote-runtime/host-status/runtime-host-status'

type PairedRuntimeParkingCapability = { capabilities?: readonly string[] }

type PairedRuntimeParkingCapabilityStatus = {
  status: PairedRuntimeParkingCapability | null | undefined
  snapshot?:
    | ({ status: PairedRuntimeParkingCapability | null } & Pick<
        RuntimeHostStatusSnapshot,
        'verification' | 'retired'
      >)
    | null
}
type PairedRuntimeParkingCapabilityStatuses = ReadonlyMap<
  string,
  PairedRuntimeParkingCapabilityStatus
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

export function runtimeEnvironmentSupportsTerminalParking(
  entry: PairedRuntimeParkingCapabilityStatus | null | undefined
): boolean {
  // Last-verified capabilities survive transport loss; explicit revocation withdraws restoration.
  return (
    !isRuntimeHostContactRevoked(entry) &&
    lastVerifiedRuntimeStatus<PairedRuntimeParkingCapability>(entry)?.capabilities?.includes(
      TERMINAL_PAIRED_PARKING_RUNTIME_CAPABILITY
    ) === true
  )
}

export function createPairedRuntimeParkingEnvironmentIdsSelector() {
  let cache: PairedRuntimeParkingEnvironmentIdsCache | null = null
  return (statuses: PairedRuntimeParkingCapabilityStatuses): ReadonlySet<string> => {
    const cached = cache
    if (cached?.statuses === statuses) {
      return cached.environmentIds
    }

    const changes = cached ? readRecordChanges(statuses, cached.statuses) : null
    const changedIds = changes?.kind === 'addressed' ? changes.keys : null
    const capable = changedIds ? new Set(cached?.environmentIds) : new Set<string>()
    const environmentIdsToInspect = changedIds ?? statuses.keys()
    for (const environmentId of environmentIdsToInspect) {
      capable.delete(environmentId)
      const entry = statuses.get(environmentId)
      if (!entry) {
        continue
      }
      if (runtimeEnvironmentSupportsTerminalParking(entry)) {
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
