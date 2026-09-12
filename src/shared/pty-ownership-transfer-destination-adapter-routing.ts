import type {
  PtyOwnershipTransferAttachmentResult,
  PtyOwnershipTransferExitEvent
} from './pty-ownership-transfer-control-wire'
import {
  PtyOwnershipTransferDestinationError,
  type DestinationAdapterState,
  type PtyOwnershipTransferDestinationAttachmentReservation,
  type PtyOwnershipTransferDestinationSnapshot
} from './pty-ownership-transfer-destination-adapter-contract'
import { requireDestinationRecord } from './pty-ownership-transfer-destination-adapter-state'
import { snapshotDestinationTransfer } from './pty-ownership-transfer-destination-adapter-replay'
import { parsePtyOwnershipTransferDestinationClaim } from './pty-ownership-transfer-destination-claim'
import { parsePtyOwnershipTransferDestinationStatus } from './pty-ownership-transfer-destination-status'
import { samePtyOwnershipTransferCommitReceipt } from './pty-ownership-transfer-receipt-validation'

export function attachDestinationExecution(
  state: DestinationAdapterState,
  result: PtyOwnershipTransferAttachmentResult,
  reservation: PtyOwnershipTransferDestinationAttachmentReservation
): PtyOwnershipTransferDestinationSnapshot {
  const record = requireDestinationRecord(state, result)
  if (
    record.pendingAttachment !== reservation ||
    reservation.bridgeId !== record.identity.bridgeId ||
    reservation.destinationRuntimeId !== record.identity.destinationRuntimeId ||
    reservation.attachmentId !== result.attachmentId
  ) {
    throw new PtyOwnershipTransferDestinationError(
      'stale-attachment',
      'destination attachment result does not match the current attachment generation'
    )
  }
  if (record.phase === 'aborted' || result.phase !== record.phase) {
    throw new PtyOwnershipTransferDestinationError(
      'invalid-phase',
      'destination attachment does not match the durable transfer phase'
    )
  }
  record.pendingAttachment = undefined
  record.attachmentId = result.attachmentId
  record.attachmentGeneration = reservation.generation
  record.executionVerdict = result.executionVerdict
  record.exit = result.exit ? structuredClone(result.exit) : undefined
  return snapshotDestinationTransfer(state)
}

export function reserveDestinationExecutionAttachment(
  state: DestinationAdapterState,
  attachmentId: string
): PtyOwnershipTransferDestinationAttachmentReservation {
  const record = requireDestinationRecord(state)
  if (record.delegatedClaim) {
    throw new PtyOwnershipTransferDestinationError(
      'stale-attachment',
      'delegated execution cannot borrow a legacy attachment'
    )
  }
  if (!attachmentId || record.phase === 'aborted' || record.executionVerdict === 'exited') {
    throw new PtyOwnershipTransferDestinationError(
      'invalid-phase',
      'destination execution cannot reserve this attachment'
    )
  }
  const reservation = Object.freeze({
    bridgeId: record.identity.bridgeId,
    destinationRuntimeId: record.identity.destinationRuntimeId,
    attachmentId,
    generation: record.nextAttachmentGeneration++
  })
  record.pendingAttachment = reservation
  record.attachmentId = undefined
  record.attachmentGeneration = undefined
  record.executionVerdict = 'unverifiable'
  return reservation
}

export function markDestinationExecutionUnverifiable(
  state: DestinationAdapterState,
  attachmentId: string
): PtyOwnershipTransferDestinationSnapshot {
  const record = requireDestinationRecord(state)
  if (record.attachmentId !== attachmentId || record.executionVerdict === 'exited') {
    return snapshotDestinationTransfer(state)
  }
  record.attachmentId = undefined
  record.attachmentGeneration = undefined
  record.executionVerdict = 'unverifiable'
  return snapshotDestinationTransfer(state)
}

export function acceptDestinationExit(
  state: DestinationAdapterState,
  event: PtyOwnershipTransferExitEvent
): PtyOwnershipTransferDestinationSnapshot {
  const record = requireDestinationRecord(state, event)
  if (record.attachmentId !== event.attachmentId) {
    throw new PtyOwnershipTransferDestinationError(
      'stale-attachment',
      'exit evidence does not match the current destination attachment'
    )
  }
  if (record.exit) {
    if (JSON.stringify(record.exit) !== JSON.stringify(event.exit)) {
      throw new PtyOwnershipTransferDestinationError(
        'exit-conflict',
        'exit evidence changed for the same ownership transfer'
      )
    }
    return snapshotDestinationTransfer(state)
  }
  record.exit = structuredClone(event.exit)
  record.executionVerdict = 'exited'
  return snapshotDestinationTransfer(state)
}

export function bindDelegatedDestinationExecution(state: DestinationAdapterState, value: unknown) {
  const record = requireDestinationRecord(state)
  const claim = parsePtyOwnershipTransferDestinationClaim(value)
  const previous = record.delegatedClaim
  if (
    record.phase === 'aborted' ||
    record.surfaceBinding?.executionHostId !== 'local' ||
    record.attachmentId ||
    record.pendingAttachment ||
    (previous &&
      (claim.generation < previous.generation ||
        (claim.generation === previous.generation && claim.claimId !== previous.claimId)))
  ) {
    throw new PtyOwnershipTransferDestinationError(
      'stale-attachment',
      'delegated execution claim conflicts with destination binding'
    )
  }
  if (previous?.generation === claim.generation && previous.claimId === claim.claimId) {
    if (!record.delegatedClaimActive) {
      throw new PtyOwnershipTransferDestinationError(
        'stale-attachment',
        'disconnected delegated claim cannot be rebound'
      )
    }
    return snapshotDestinationTransfer(state)
  }
  record.delegatedClaim = claim
  record.delegatedClaimActive = true
  if (!record.exit) {
    record.executionVerdict = 'unverifiable'
  }
  return snapshotDestinationTransfer(state)
}

export function markDelegatedDestinationExecutionUnverifiable(
  state: DestinationAdapterState,
  value: unknown
) {
  const record = requireDestinationRecord(state)
  const claim = parsePtyOwnershipTransferDestinationClaim(value)
  if (
    record.delegatedClaim?.generation === claim.generation &&
    record.delegatedClaim.claimId === claim.claimId
  ) {
    record.delegatedClaimActive = false
    if (!record.exit) {
      record.executionVerdict = 'unverifiable'
    }
  }
  return snapshotDestinationTransfer(state)
}

export function acceptDelegatedDestinationExecutionStatus(
  state: DestinationAdapterState,
  value: unknown
) {
  const status = parsePtyOwnershipTransferDestinationStatus(value)
  const record = requireDestinationRecord(state, status)
  if (
    (record.phase !== 'committed' && record.phase !== 'published') ||
    status.phase !== 'committed' ||
    !record.commitReceipt ||
    !status.receipt ||
    !samePtyOwnershipTransferCommitReceipt(record.commitReceipt, status.receipt) ||
    !record.delegatedClaim ||
    !record.delegatedClaimActive ||
    !status.boundToConnection ||
    status.destinationClaim?.generation !== record.delegatedClaim.generation ||
    status.destinationClaim.claimId !== record.delegatedClaim.claimId
  ) {
    throw new PtyOwnershipTransferDestinationError(
      'stale-attachment',
      'execution evidence does not match the delegated commit and claim'
    )
  }
  if (record.exit) {
    if (status.exit && JSON.stringify(record.exit) !== JSON.stringify(status.exit)) {
      throw new PtyOwnershipTransferDestinationError(
        'exit-conflict',
        'delegated exit evidence changed'
      )
    }
    return snapshotDestinationTransfer(state)
  }
  if (status.exit) {
    if (
      status.sourceOutputEndSeq === undefined ||
      status.sourceOutputEndSeq !== record.liveOutputEndSeq
    ) {
      throw new PtyOwnershipTransferDestinationError(
        'output-gap',
        'delegated exit requires the final source output cursor'
      )
    }
    record.exit = structuredClone(status.exit)
  }
  record.executionVerdict = status.executionVerdict ?? 'unverifiable'
  return snapshotDestinationTransfer(state)
}
