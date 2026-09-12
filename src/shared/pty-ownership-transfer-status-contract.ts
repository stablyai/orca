import type {
  PtyOwnershipTransferCommitReceipt,
  PtyOwnershipTransferPublicationReceipt
} from './pty-ownership-transfer-journal-contract'
import type { PtyOwnershipTransferSurfacePublication } from './pty-ownership-transfer-surface-publication'
import type { PtyOwnershipTransferDestinationDelegation } from './pty-ownership-transfer-destination-delegation'
import type { PtyOwnershipTransferExit } from './pty-ownership-transfer-control-wire'
import type { PtyOwnershipTransferWireIdentity } from './pty-ownership-transfer-wire'
import {
  parsePtyOwnershipTransferWireIdentity,
  PTY_OWNERSHIP_TRANSFER_WIRE_VERSION
} from './pty-ownership-transfer-wire'

/** Read-only recovery snapshot. It is additive and safe to probe on mixed-version peers. */
export type PtyOwnershipTransferStatusRequest = PtyOwnershipTransferWireIdentity &
  Readonly<{ version: typeof PTY_OWNERSHIP_TRANSFER_WIRE_VERSION }>

export type PtyOwnershipTransferStatusResult = PtyOwnershipTransferWireIdentity &
  Readonly<{
    version: typeof PTY_OWNERSHIP_TRANSFER_WIRE_VERSION
    phase: 'prepared' | 'committed' | 'published' | 'aborted'
    sourceOutputEndSeq: number
    replayStartSeq: number
    acceptedSourceEndSeq: number
    acceptedInputIds: number
    /** Last durable relay route generation; absent on older relays and unattached transfers. */
    reconnectGeneration?: number
    commitReceipt?: PtyOwnershipTransferCommitReceipt
    publicationReceipt?: PtyOwnershipTransferPublicationReceipt
    surfacePublication?: PtyOwnershipTransferSurfacePublication
    /** Observed credential binding only; absence on older hosts is not confirmation. */
    destinationDelegation?: PtyOwnershipTransferDestinationDelegation
    /** Host-positive exit evidence. Absence remains unknown for mixed-version peers. */
    exit?: PtyOwnershipTransferExit
  }>

export function parsePtyOwnershipTransferStatusRequest(
  value: unknown
): PtyOwnershipTransferStatusRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('pty_ownership_transfer_request_invalid')
  }
  const record = value as Record<string, unknown>
  if (record.version !== PTY_OWNERSHIP_TRANSFER_WIRE_VERSION) {
    throw new Error('pty_ownership_transfer_wire_version_unsupported')
  }
  return Object.freeze({
    ...parsePtyOwnershipTransferWireIdentity(record),
    version: PTY_OWNERSHIP_TRANSFER_WIRE_VERSION
  })
}
