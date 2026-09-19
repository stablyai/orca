import type { PtyOwnershipTransferWireIdentity } from './pty-ownership-transfer-wire'

export function samePtyOwnershipTransferIdentity(
  left: PtyOwnershipTransferWireIdentity,
  right: PtyOwnershipTransferWireIdentity
): boolean {
  return (
    left.bridgeId === right.bridgeId &&
    left.terminalId === right.terminalId &&
    left.incarnationId === right.incarnationId &&
    left.ownerLease === right.ownerLease &&
    left.sourceOwnerGeneration === right.sourceOwnerGeneration &&
    left.destinationRuntimeId === right.destinationRuntimeId
  )
}
