import {
  parsePtyOwnershipTransferDestinationInspectionRequest,
  parsePtyOwnershipTransferDestinationClaim
} from './pty-ownership-transfer-destination-claim'
import { parsePtyOwnershipTransferWireIdentity } from './pty-ownership-transfer-wire'

export const PTY_OWNERSHIP_TRANSFER_DESTINATION_CWD_METHOD = 'pty.ownershipTransfer.destinationCwd'

export function parsePtyOwnershipTransferDestinationCwdRequest(value: unknown) {
  return parsePtyOwnershipTransferDestinationInspectionRequest(value)
}

export function parsePtyOwnershipTransferDestinationCwdResult(value: unknown) {
  const identity = parsePtyOwnershipTransferWireIdentity(value)
  const record = value as Record<string, unknown>
  if (
    record.version !== 1 ||
    (record.cwd !== null &&
      (typeof record.cwd !== 'string' ||
        !record.cwd ||
        record.cwd.length > 32768 ||
        record.cwd.includes('\0')))
  ) {
    throw new Error('pty_ownership_transfer_destination_cwd_result_invalid')
  }
  return Object.freeze({
    ...identity,
    version: 1 as const,
    destinationClaim: parsePtyOwnershipTransferDestinationClaim(record.destinationClaim),
    cwd: record.cwd as string | null
  })
}
