import type { PtyOwnershipTransferWireIdentity } from './pty-ownership-transfer-wire'
import {
  boundedPositive,
  assertIdentity
} from './pty-ownership-transfer-destination-adapter-validation'
import {
  PTY_OWNERSHIP_TRANSFER_DESTINATION_DEFAULT_INPUT_IDS,
  PTY_OWNERSHIP_TRANSFER_DESTINATION_MAX_INPUT_IDS,
  PtyOwnershipTransferDestinationError,
  type DestinationAdapterState,
  type DestinationRecord,
  type PtyOwnershipTransferDestinationAdapterOptions
} from './pty-ownership-transfer-destination-adapter-contract'

export function createDestinationAdapterState(
  options: PtyOwnershipTransferDestinationAdapterOptions
): DestinationAdapterState {
  return {
    options,
    inputIds: boundedPositive(
      options.inputIds ?? PTY_OWNERSHIP_TRANSFER_DESTINATION_DEFAULT_INPUT_IDS,
      PTY_OWNERSHIP_TRANSFER_DESTINATION_MAX_INPUT_IDS
    ),
    record: null
  }
}

export function requireDestinationRecord(
  state: DestinationAdapterState,
  request?: PtyOwnershipTransferWireIdentity
): DestinationRecord {
  const record = state.record
  if (!record) {
    throw new PtyOwnershipTransferDestinationError(
      'invalid-request',
      'destination transfer has not been prepared'
    )
  }
  if (request) {
    assertIdentity(record.identity, request)
  }
  return record
}
