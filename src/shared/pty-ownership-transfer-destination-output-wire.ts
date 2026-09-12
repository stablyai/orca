import { parsePtyOwnershipTransferWireIdentity } from './pty-ownership-transfer-wire'
import { parsePtyOwnershipTransferDestinationClaim } from './pty-ownership-transfer-destination-claim'
import { parseOutputFrame } from './pty-ownership-transfer-wire-results'
import { PTY_OWNERSHIP_TRANSFER_DESTINATION_MAX_FRAME_BYTES } from './pty-ownership-transfer-destination-adapter'

export const RELAY_PTY_DESTINATION_OUTPUT_NOTIFICATION = 'pty.ownershipTransfer.destinationOutput'

export function parsePtyOwnershipTransferDestinationOutputAck(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('pty_ownership_transfer_destination_output_ack_invalid')
  }
  const record = value as Record<string, unknown>
  if (
    record.version !== 1 ||
    !Number.isSafeInteger(record.acknowledgedThroughSeq) ||
    Number(record.acknowledgedThroughSeq) < 0
  ) {
    throw new Error('pty_ownership_transfer_destination_output_ack_invalid')
  }
  return Object.freeze({
    ...parsePtyOwnershipTransferWireIdentity(record),
    version: 1 as const,
    acknowledgedThroughSeq: Number(record.acknowledgedThroughSeq)
  })
}

export function parsePtyOwnershipTransferDestinationOutput(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('pty_ownership_transfer_destination_output_invalid')
  }
  const record = value as Record<string, unknown>
  const frame = parseOutputFrame(record.frame)
  if (
    record.version !== 1 ||
    frame.seq < 1 ||
    frame.truncated ||
    Buffer.byteLength(frame.data, 'utf8') > PTY_OWNERSHIP_TRANSFER_DESTINATION_MAX_FRAME_BYTES
  ) {
    throw new Error('pty_ownership_transfer_destination_output_invalid')
  }
  return Object.freeze({
    ...parsePtyOwnershipTransferWireIdentity(record),
    version: 1 as const,
    destinationClaim: parsePtyOwnershipTransferDestinationClaim(record.destinationClaim),
    frame
  })
}
