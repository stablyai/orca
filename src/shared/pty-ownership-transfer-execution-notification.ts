import { parsePtyOwnershipTransferWireIdentity } from './pty-ownership-transfer-wire'
import { parsePtyOwnershipTransferDestinationClaim } from './pty-ownership-transfer-destination-claim'

export const RELAY_PTY_DESTINATION_EXECUTION_NOTIFICATION =
  'pty.ownershipTransfer.destinationExecutionChanged'

export function parsePtyOwnershipTransferExecutionNotification(value: unknown) {
  const identity = parsePtyOwnershipTransferWireIdentity(value)
  const record = value as Record<string, unknown>
  if (
    record.version !== 1 ||
    !Number.isSafeInteger(record.finalOutputSeq) ||
    Number(record.finalOutputSeq) < 0
  ) {
    throw new Error('pty_ownership_transfer_execution_notification_invalid')
  }
  return Object.freeze({
    ...identity,
    version: 1 as const,
    destinationClaim: parsePtyOwnershipTransferDestinationClaim(record.destinationClaim),
    finalOutputSeq: Number(record.finalOutputSeq)
  })
}
