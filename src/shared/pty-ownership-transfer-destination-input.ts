import {
  parsePtyOwnershipTransferInputRequest,
  parsePtyOwnershipTransferRetireInputRequest
} from './pty-ownership-transfer-wire'
import {
  parsePtyOwnershipTransferDestinationProof,
  parsePtyOwnershipTransferDestinationClaim
} from './pty-ownership-transfer-destination-claim'

export const PTY_OWNERSHIP_TRANSFER_DESTINATION_MAX_DURABLE_INPUT_BYTES = 4 * 1024 * 1024
export const PTY_OWNERSHIP_TRANSFER_DESTINATION_INPUT_METHOD =
  'pty.ownershipTransfer.destinationInput'
export const PTY_OWNERSHIP_TRANSFER_DESTINATION_RETIRE_INPUT_METHOD =
  'pty.ownershipTransfer.retireDestinationInput'

export function parsePtyOwnershipTransferDestinationInputRequest(value: unknown) {
  const input = parsePtyOwnershipTransferInputRequest(value)
  if (input.inputId.length > 256) {
    throw new Error('pty_ownership_transfer_destination_input_id_invalid')
  }
  return Object.freeze({
    ...input,
    inputEpoch: parseInputEpoch((value as Record<string, unknown>).inputEpoch),
    ...parsePtyOwnershipTransferDestinationProof(value),
    destinationClaim: parsePtyOwnershipTransferDestinationClaim(
      (value as Record<string, unknown>).destinationClaim
    )
  })
}

export function parsePtyOwnershipTransferDestinationRetireInputRequest(value: unknown) {
  const retired = parsePtyOwnershipTransferRetireInputRequest(value)
  const record = value as Record<string, unknown>
  const inputEpoch = parseInputEpoch(record.inputEpoch)
  if (
    inputEpoch === Number.MAX_SAFE_INTEGER ||
    new Set(retired.inputIds).size !== retired.inputIds.length
  ) {
    throw new Error('pty_ownership_transfer_destination_input_epoch_invalid')
  }
  return Object.freeze({
    ...retired,
    ...parsePtyOwnershipTransferDestinationProof(value),
    inputEpoch,
    destinationClaim: parsePtyOwnershipTransferDestinationClaim(record.destinationClaim)
  })
}

function parseInputEpoch(value: unknown): number {
  if (value === undefined) {
    return 0
  }
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error('pty_ownership_transfer_destination_input_epoch_invalid')
  }
  return Number(value)
}
