import {
  PTY_OWNERSHIP_TRANSFER_PUBLICATION_RECEIPT_VERSION,
  type PtyOwnershipTransferCommitReceipt,
  type PtyOwnershipTransferDestinationJournal,
  type PtyOwnershipTransferIdentity,
  type PtyOwnershipTransferPublicationReceipt
} from './pty-ownership-transfer-journal-contract'
import type {
  PtyOwnershipTransferOutputFrame,
  PtyOwnershipTransferPrepareResult,
  PtyOwnershipTransferReplayResult,
  PtyOwnershipTransferSurfacePublication,
  PtyOwnershipTransferWireIdentity
} from './pty-ownership-transfer-wire'
import { PTY_OWNERSHIP_TRANSFER_SURFACE_PUBLICATION_VERSION } from './pty-ownership-transfer-wire'
import {
  PTY_OWNERSHIP_TRANSFER_DESTINATION_MAX_FRAME_BYTES,
  PtyOwnershipTransferDestinationError
} from './pty-ownership-transfer-destination-adapter-contract'
import {
  parsePtyOwnershipTransferSurfaceBinding,
  samePtyOwnershipTransferSurfaceBinding,
  type PtyOwnershipTransferSurfaceBinding
} from './pty-ownership-transfer-surface-binding'
import { samePtyOwnershipTransferPublicationReceipt } from './pty-ownership-transfer-receipt-validation'

export function identityFrom(
  value: PtyOwnershipTransferPrepareResult
): PtyOwnershipTransferWireIdentity {
  return {
    bridgeId: value.bridgeId,
    terminalId: value.terminalId,
    incarnationId: value.incarnationId,
    ownerLease: value.ownerLease,
    sourceOwnerGeneration: value.sourceOwnerGeneration,
    destinationRuntimeId: value.destinationRuntimeId
  }
}

export function validatePrepareResult(value: PtyOwnershipTransferPrepareResult): void {
  validateTransferCursor(value)
  validateSurfacePublication(value.surfacePublication)
}

function validateTransferCursor(value: {
  version: number
  bridgeId: string
  terminalId: string
  incarnationId: string
  ownerLease: string
  sourceOwnerGeneration: number
  destinationRuntimeId: string
  sourceOutputEndSeq: number
  replayStartSeq: number
}): void {
  if (
    value.version !== 1 ||
    !value.bridgeId ||
    !value.terminalId ||
    !value.incarnationId ||
    !value.ownerLease ||
    !value.destinationRuntimeId ||
    !Number.isSafeInteger(value.sourceOwnerGeneration) ||
    value.sourceOwnerGeneration <= 0 ||
    !validSequence(value.sourceOutputEndSeq) ||
    !validSequence(value.replayStartSeq) ||
    value.replayStartSeq > value.sourceOutputEndSeq + 1
  ) {
    throw new PtyOwnershipTransferDestinationError('invalid-request', 'prepare result is malformed')
  }
}

export function validateReplayResult(value: PtyOwnershipTransferReplayResult): void {
  if (value.phase !== 'prepared') {
    throw new PtyOwnershipTransferDestinationError(
      'invalid-phase',
      'prepared destination replay cannot accept post-commit output'
    )
  }
  validateTransferCursor(value)
  // A replay response may be incremental (afterSeq > replayStartSeq - 1), so
  // validate ordering from the first frame rather than requiring the retained
  // history's lower bound on every response.
  let previous = value.frames[0]?.seq ? value.frames[0].seq - 1 : value.replayStartSeq - 1
  for (const frame of value.frames) {
    validateFrame(frame)
    if (frame.seq !== previous + 1) {
      throw new PtyOwnershipTransferDestinationError('output-gap', 'replay frames are not ordered')
    }
    previous = frame.seq
  }
  if (previous > value.sourceOutputEndSeq) {
    throw new PtyOwnershipTransferDestinationError(
      'output-conflict',
      'replay exceeds source cursor'
    )
  }
}

export function validateFrame(frame: PtyOwnershipTransferOutputFrame): void {
  if (
    !validSequence(frame.seq) ||
    typeof frame.data !== 'string' ||
    frame.data.length === 0 ||
    frame.truncated === true ||
    Buffer.byteLength(frame.data, 'utf8') > PTY_OWNERSHIP_TRANSFER_DESTINATION_MAX_FRAME_BYTES
  ) {
    throw new PtyOwnershipTransferDestinationError('output-conflict', 'output frame is malformed')
  }
}

export function validatePublicationReceipt(
  record: {
    identity: PtyOwnershipTransferWireIdentity
    commitReceipt?: PtyOwnershipTransferCommitReceipt
    surfaceBinding?: PtyOwnershipTransferSurfaceBinding
    surfacePublication?: PtyOwnershipTransferSurfacePublication
  },
  receipt: PtyOwnershipTransferPublicationReceipt,
  expected?: PtyOwnershipTransferPublicationReceipt
): void {
  if (
    receipt.version !== PTY_OWNERSHIP_TRANSFER_PUBLICATION_RECEIPT_VERSION ||
    receipt.publicationReceiptId.length === 0 ||
    receipt.bridgeId !== record.identity.bridgeId ||
    receipt.destinationRuntimeId !== record.identity.destinationRuntimeId ||
    !record.commitReceipt ||
    !sameCommitReceipt(receipt.commitReceipt, record.commitReceipt) ||
    !Number.isFinite(Date.parse(receipt.publishedAt)) ||
    !record.surfaceBinding ||
    !record.surfacePublication ||
    record.surfacePublication.version !== PTY_OWNERSHIP_TRANSFER_SURFACE_PUBLICATION_VERSION ||
    !samePtyOwnershipTransferSurfaceBinding(
      record.surfaceBinding,
      record.surfacePublication.surfaceBinding
    ) ||
    !samePtyOwnershipTransferSurfaceBinding(receipt.surfaceBinding, record.surfaceBinding) ||
    (expected !== undefined && !samePtyOwnershipTransferPublicationReceipt(receipt, expected))
  ) {
    throw new PtyOwnershipTransferDestinationError(
      'publication-invalid',
      'publication receipt does not prove the durable destination commit'
    )
  }
}

export function validateSurfaceBinding(
  binding: PtyOwnershipTransferSurfaceBinding
): PtyOwnershipTransferSurfaceBinding {
  try {
    return parsePtyOwnershipTransferSurfaceBinding(binding)
  } catch {
    throw new PtyOwnershipTransferDestinationError(
      'surface-conflict',
      'destination surface binding is malformed'
    )
  }
}

export function validateSurfacePublication(
  value: PtyOwnershipTransferSurfacePublication | undefined
): PtyOwnershipTransferSurfacePublication | undefined {
  if (value === undefined) {
    return undefined
  }
  if (value.version !== PTY_OWNERSHIP_TRANSFER_SURFACE_PUBLICATION_VERSION) {
    throw new PtyOwnershipTransferDestinationError(
      'invalid-request',
      'surface-publication negotiation is unsupported'
    )
  }
  try {
    return Object.freeze({
      version: PTY_OWNERSHIP_TRANSFER_SURFACE_PUBLICATION_VERSION,
      surfaceBinding: parsePtyOwnershipTransferSurfaceBinding(value.surfaceBinding)
    })
  } catch {
    throw new PtyOwnershipTransferDestinationError(
      'invalid-request',
      'surface-publication negotiation is malformed'
    )
  }
}

export function assertSameCommitReceipt(
  expected: PtyOwnershipTransferCommitReceipt | undefined,
  actual: PtyOwnershipTransferCommitReceipt
): void {
  if (!expected || !sameCommitReceipt(expected, actual)) {
    throw new PtyOwnershipTransferDestinationError(
      'receipt-invalid',
      'commit receipt changed while recovering a destination transfer'
    )
  }
}

export function assertJournalIdentity(
  journal: PtyOwnershipTransferDestinationJournal,
  identity: PtyOwnershipTransferIdentity
): void {
  assertIdentity(journal, identity)
}

export function assertIdentity(
  expected: PtyOwnershipTransferIdentity,
  actual: PtyOwnershipTransferIdentity
): void {
  if (
    expected.bridgeId !== actual.bridgeId ||
    expected.terminalId !== actual.terminalId ||
    expected.incarnationId !== actual.incarnationId ||
    expected.ownerLease !== actual.ownerLease ||
    expected.sourceOwnerGeneration !== actual.sourceOwnerGeneration ||
    expected.destinationRuntimeId !== actual.destinationRuntimeId
  ) {
    throw new PtyOwnershipTransferDestinationError(
      'identity-mismatch',
      'destination transfer identity does not match its durable journal'
    )
  }
}

export function bytesOf(frames: Iterable<PtyOwnershipTransferOutputFrame>): number {
  let total = 0
  for (const frame of frames) {
    total += Buffer.byteLength(frame.data, 'utf8')
  }
  return total
}

export function validSequence(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0
}

export function boundedPositive(value: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new PtyOwnershipTransferDestinationError(
      'invalid-request',
      'destination transfer bound must be a positive safe integer'
    )
  }
  return Math.min(value, maximum)
}

function sameCommitReceipt(
  left: PtyOwnershipTransferCommitReceipt,
  right: PtyOwnershipTransferCommitReceipt
): boolean {
  return (
    left.receiptId === right.receiptId &&
    left.bridgeId === right.bridgeId &&
    left.acceptedSourceEndSeq === right.acceptedSourceEndSeq &&
    left.committedAt === right.committedAt
  )
}
