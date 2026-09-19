import { isRemoteForegroundEvidence } from './foreground-process-evidence'
import { parsePtyOwnershipTransferWireIdentity } from './pty-ownership-transfer-wire'
import { parsePtyOwnershipTransferDestinationClaim } from './pty-ownership-transfer-destination-claim'

export const PTY_OWNERSHIP_TRANSFER_DESTINATION_PROCESS_METHOD =
  'pty.ownershipTransfer.destinationProcess'

export function parsePtyOwnershipTransferDestinationProcessResult(value: unknown) {
  const identity = parsePtyOwnershipTransferWireIdentity(value)
  const record = value as Record<string, unknown>
  const evidence = record.foregroundProcessEvidence
  const children = record.childProcessEvidence
  if (
    record.version !== 1 ||
    !isRemoteForegroundEvidence(evidence) ||
    evidence.ptyId !== identity.terminalId ||
    evidence.ptyIncarnationId !== identity.incarnationId ||
    evidence.verdict === 'exited' ||
    (children !== 'children' && children !== 'no-children' && children !== 'unverifiable')
  ) {
    throw new Error('pty_ownership_transfer_destination_process_result_invalid')
  }
  return Object.freeze({
    ...identity,
    version: 1 as const,
    destinationClaim: parsePtyOwnershipTransferDestinationClaim(record.destinationClaim),
    foregroundProcessEvidence: structuredClone(evidence),
    childProcessEvidence: children as 'children' | 'no-children' | 'unverifiable'
  })
}
