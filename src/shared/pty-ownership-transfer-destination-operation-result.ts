import { parsePtyOwnershipTransferWireIdentity } from './pty-ownership-transfer-wire'

export function parsePtyOwnershipTransferDestinationOperationResult(value: unknown) {
  const identity = parsePtyOwnershipTransferWireIdentity(value)
  const record = value as Record<string, unknown>
  if (
    record.version !== 1 ||
    typeof record.duplicate !== 'boolean' ||
    (record.outcome !== 'applied' && record.outcome !== 'unverifiable')
  ) {
    throw new Error('pty_ownership_transfer_destination_operation_result_invalid')
  }
  return Object.freeze({
    ...identity,
    version: 1 as const,
    outcome: record.outcome as 'applied' | 'unverifiable',
    duplicate: record.duplicate
  })
}
