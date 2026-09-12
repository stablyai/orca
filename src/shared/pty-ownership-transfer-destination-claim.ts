import {
  parsePtyOwnershipTransferWireIdentity,
  parsePtyOwnershipTransferReplayRequest,
  parsePtyOwnershipTransferCommitRequest,
  type PtyOwnershipTransferWireIdentity
} from './pty-ownership-transfer-wire'

export const PTY_OWNERSHIP_TRANSFER_DESTINATION_CLAIM_METHOD =
  'pty.ownershipTransfer.claimDestination'
export const PTY_OWNERSHIP_TRANSFER_DESTINATION_STATUS_METHOD =
  'pty.ownershipTransfer.destinationStatus'
export const PTY_OWNERSHIP_TRANSFER_DESTINATION_RECOVER_METHOD =
  'pty.ownershipTransfer.recoverDestination'
export const PTY_OWNERSHIP_TRANSFER_DESTINATION_REPLAY_METHOD =
  'pty.ownershipTransfer.replayDestination'
export const PTY_OWNERSHIP_TRANSFER_DESTINATION_ACK_METHOD =
  'pty.ownershipTransfer.ackDestinationOutput'
export const PTY_OWNERSHIP_TRANSFER_DESTINATION_SUBSCRIBE_METHOD =
  'pty.ownershipTransfer.subscribeDestinationOutput'
export const PTY_OWNERSHIP_TRANSFER_DESTINATION_COMMIT_METHOD =
  'pty.ownershipTransfer.commitDestination'

export type PtyOwnershipTransferDestinationProof = PtyOwnershipTransferWireIdentity &
  Readonly<{ version: 1; credential: string }>

export type PtyOwnershipTransferDestinationClaim = Readonly<{
  generation: number
  claimId: string
}>

export type PtyOwnershipTransferDestinationClaimRequest = PtyOwnershipTransferDestinationProof &
  Readonly<{
    previousDestinationGeneration: number
    destinationGeneration: number
    claimId: string
  }>

export function parsePtyOwnershipTransferDestinationProof(
  value: unknown
): PtyOwnershipTransferDestinationProof {
  const record = requireRecord(value)
  if (
    record.version !== 1 ||
    typeof record.credential !== 'string' ||
    !/^[a-f0-9]{64}$/.test(record.credential)
  ) {
    throw new Error('pty_ownership_transfer_destination_claim_invalid')
  }
  return Object.freeze({
    ...parsePtyOwnershipTransferWireIdentity(record),
    version: 1,
    credential: record.credential
  })
}

export function parsePtyOwnershipTransferDestinationClaim(
  value: unknown
): PtyOwnershipTransferDestinationClaim {
  const record = requireRecord(value)
  if (
    !Number.isSafeInteger(record.generation) ||
    Number(record.generation) < 1 ||
    typeof record.claimId !== 'string' ||
    !record.claimId ||
    record.claimId.length > 128
  ) {
    throw new Error('pty_ownership_transfer_destination_claim_invalid')
  }
  return Object.freeze({ generation: Number(record.generation), claimId: record.claimId })
}

export function parsePtyOwnershipTransferDestinationClaimRequest(
  value: unknown
): PtyOwnershipTransferDestinationClaimRequest {
  const record = requireRecord(value)
  const claim = parsePtyOwnershipTransferDestinationClaim({
    generation: record.destinationGeneration,
    claimId: record.claimId
  })
  if (
    !Number.isSafeInteger(record.previousDestinationGeneration) ||
    Number(record.previousDestinationGeneration) < 0 ||
    claim.generation !== Number(record.previousDestinationGeneration) + 1
  ) {
    throw new Error('pty_ownership_transfer_destination_claim_invalid')
  }
  return Object.freeze({
    ...parsePtyOwnershipTransferDestinationProof(record),
    previousDestinationGeneration: Number(record.previousDestinationGeneration),
    destinationGeneration: claim.generation,
    claimId: claim.claimId
  })
}

export function parsePtyOwnershipTransferDestinationReplayRequest(value: unknown) {
  const record = requireRecord(value)
  const replay = parsePtyOwnershipTransferReplayRequest(record)
  if (replay.attachmentId !== undefined) {
    throw new Error('pty_ownership_transfer_destination_claim_invalid')
  }
  return Object.freeze({
    ...parsePtyOwnershipTransferDestinationProof(record),
    destinationClaim: parsePtyOwnershipTransferDestinationClaim(record.destinationClaim),
    afterSeq: replay.afterSeq
  })
}

export function parsePtyOwnershipTransferDestinationCommitRequest(value: unknown) {
  const record = requireRecord(value)
  return Object.freeze({
    ...parsePtyOwnershipTransferCommitRequest(record),
    ...parsePtyOwnershipTransferDestinationProof(record),
    destinationClaim: parsePtyOwnershipTransferDestinationClaim(record.destinationClaim)
  })
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('pty_ownership_transfer_destination_claim_invalid')
  }
  return value as Record<string, unknown>
}
export function parsePtyOwnershipTransferDestinationInspectionRequest(value: unknown) {
  const proof = parsePtyOwnershipTransferDestinationProof(value)
  return Object.freeze({
    ...proof,
    destinationClaim: parsePtyOwnershipTransferDestinationClaim(
      (value as Record<string, unknown>).destinationClaim
    )
  })
}
