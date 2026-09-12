import {
  PTY_OWNERSHIP_BRIDGE_MAX_INPUT_IDS,
  PTY_OWNERSHIP_BRIDGE_MAX_REPLAY_BYTES,
  PTY_OWNERSHIP_BRIDGE_PROTOCOL_VERSION,
  type PtyOwnershipBridgeCapabilities,
  type PtyOwnershipBridgeHello
} from './pty-ownership-bridge-contract'
import { PtyOwnershipBridgeError } from './pty-ownership-bridge-errors'

export function isPtyOwnershipBridgeCapabilities(
  value: unknown
): value is PtyOwnershipBridgeCapabilities {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  const candidate = value as Record<string, unknown>
  return (
    Array.isArray(candidate.protocolVersions) &&
    candidate.protocolVersions.length > 0 &&
    candidate.protocolVersions.every(
      (version) => Number.isSafeInteger(version) && Number(version) > 0
    ) &&
    Number.isSafeInteger(candidate.maxReplayBytes) &&
    Number(candidate.maxReplayBytes) > 0 &&
    Number.isSafeInteger(candidate.maxInputIds) &&
    Number(candidate.maxInputIds) > 0 &&
    typeof candidate.inputDeduplication === 'boolean' &&
    typeof candidate.rollback === 'boolean' &&
    typeof candidate.liveTransfer === 'boolean'
  )
}

/** Decode untrusted capability RPC data without retaining a peer-owned object. */
export function parsePtyOwnershipBridgeCapabilities(
  value: unknown
): PtyOwnershipBridgeCapabilities | null {
  if (!isPtyOwnershipBridgeCapabilities(value)) {
    return null
  }
  const sourceRetirement =
    value.liveTransfer &&
    value.destinationDelegationVersion === 1 &&
    value.sourceRetirementVersion === 1
  return Object.freeze({
    protocolVersions: Object.freeze([...value.protocolVersions]),
    maxReplayBytes: value.maxReplayBytes,
    maxInputIds: value.maxInputIds,
    inputDeduplication: value.inputDeduplication,
    rollback: value.rollback,
    liveTransfer: value.liveTransfer,
    ...(value.liveTransfer &&
    value.destinationDelegationVersion === 1 &&
    value.sourceSuccessorRetirementVersion === 1
      ? { sourceSuccessorRetirementVersion: 1 as const }
      : {}),
    ...(sourceRetirement ? { sourceRetirementVersion: 1 as const } : {}),
    ...(sourceRetirement && value.sourceRetirementBoundaryVersion === 1
      ? { sourceRetirementBoundaryVersion: 1 as const }
      : {}),
    ...(sourceRetirement && value.sourceRetirementRecoveryVersion === 1
      ? { sourceRetirementRecoveryVersion: 1 as const }
      : {}),
    ...(value.liveTransfer && value.preparationShutdownGuardVersion === 1
      ? { preparationShutdownGuardVersion: 1 as const }
      : {}),
    ...(value.liveTransfer && value.transferGraceGuardVersion === 1
      ? { transferGraceGuardVersion: 1 as const }
      : {}),
    ...(value.liveTransfer && value.transferLifecycleGuardVersion === 1
      ? { transferLifecycleGuardVersion: 1 as const }
      : {}),
    ...(value.statusQuery === true ? { statusQuery: true } : {}),
    ...(value.destinationOutput === true ? { destinationOutput: true } : {}),
    ...(value.destinationControl === true ? { destinationControl: true } : {}),
    ...(value.authoritativeExit === true ? { authoritativeExit: true } : {}),
    ...(value.postCommitReplay === true ? { postCommitReplay: true } : {}),
    ...(value.reconnectRekey === true ? { reconnectRekey: true } : {}),
    ...(value.liveTransfer && value.destinationDelegationVersion === 1
      ? { destinationDelegationVersion: 1 as const }
      : {}),
    ...(value.captureBoundaryVersion === 1 ? { captureBoundaryVersion: 1 as const } : {}),
    ...(value.captureBoundaryVersion === 1 && value.captureSelectionVersion === 1
      ? { captureSelectionVersion: 1 as const }
      : {}),
    ...(value.liveTransfer &&
    value.destinationDelegationVersion === 1 &&
    value.captureBoundaryVersion === 1 &&
    value.captureSelectionVersion === 1 &&
    value.captureSelectionRecoveryVersion === 1
      ? { captureSelectionRecoveryVersion: 1 as const }
      : {})
  })
}

export function assertPtyOwnershipBridgeHello(hello: PtyOwnershipBridgeHello): void {
  if (
    !hello.terminalId ||
    !hello.incarnationId ||
    !hello.ownerLease ||
    !hello.capabilities ||
    !Array.isArray(hello.capabilities.protocolVersions) ||
    hello.capabilities.protocolVersions.length === 0
  ) {
    throw new PtyOwnershipBridgeError('invalid-capabilities', 'bridge hello is incomplete')
  }
  assertPtyOwnershipBridgeCapabilities(hello.capabilities)
}

function assertPtyOwnershipBridgeCapabilities(capabilities: PtyOwnershipBridgeCapabilities): void {
  if (
    capabilities.protocolVersions.some(
      (version) => !Number.isSafeInteger(version) || version <= 0
    ) ||
    !Number.isSafeInteger(capabilities.maxReplayBytes) ||
    capabilities.maxReplayBytes <= 0 ||
    !Number.isSafeInteger(capabilities.maxInputIds) ||
    capabilities.maxInputIds <= 0
  ) {
    throw new PtyOwnershipBridgeError('invalid-capabilities', 'bridge capabilities are invalid')
  }
}

export function commonPtyOwnershipBridgeProtocolVersion(
  left: readonly number[],
  right: readonly number[]
): 1 | null {
  return left.includes(PTY_OWNERSHIP_BRIDGE_PROTOCOL_VERSION) &&
    right.includes(PTY_OWNERSHIP_BRIDGE_PROTOCOL_VERSION)
    ? PTY_OWNERSHIP_BRIDGE_PROTOCOL_VERSION
    : null
}

export function boundedPtyOwnershipBridgeMinimum(
  requested: number,
  left: number,
  right: number,
  maximum: number
): number {
  if (!Number.isSafeInteger(requested) || requested <= 0) {
    throw new PtyOwnershipBridgeError('invalid-capabilities', 'bridge bound must be positive')
  }
  return Math.min(requested, left, right, maximum)
}

export { PTY_OWNERSHIP_BRIDGE_MAX_INPUT_IDS, PTY_OWNERSHIP_BRIDGE_MAX_REPLAY_BYTES }
