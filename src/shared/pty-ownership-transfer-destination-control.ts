import { parseControl } from './pty-ownership-transfer-control-wire'
import {
  parsePtyOwnershipTransferDestinationProof,
  parsePtyOwnershipTransferDestinationClaim
} from './pty-ownership-transfer-destination-claim'

export const PTY_OWNERSHIP_TRANSFER_DESTINATION_CONTROL_METHOD =
  'pty.ownershipTransfer.destinationControl'

export function parsePtyOwnershipTransferDestinationControlRequest(value: unknown) {
  const proof = parsePtyOwnershipTransferDestinationProof(value)
  const record = value as Record<string, unknown>
  if (typeof record.controlId !== 'string' || !record.controlId || record.controlId.length > 256) {
    throw new Error('pty_ownership_transfer_destination_control_id_invalid')
  }
  return Object.freeze({
    ...proof,
    controlId: record.controlId,
    control: parseControl(record.control),
    destinationClaim: parsePtyOwnershipTransferDestinationClaim(record.destinationClaim)
  })
}
