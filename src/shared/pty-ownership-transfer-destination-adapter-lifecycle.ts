import type {
  PtyOwnershipTransferCommitReceipt,
  PtyOwnershipTransferPublicationReceipt
} from './pty-ownership-transfer-journal-contract'
import type { PtyOwnershipTransferOutputFrame } from './pty-ownership-transfer-wire'
import {
  samePtyOwnershipTransferSurfaceBinding,
  type PtyOwnershipTransferSurfaceBinding
} from './pty-ownership-transfer-surface-binding'
import {
  PtyOwnershipTransferDestinationError,
  type DestinationAdapterState,
  type PtyOwnershipTransferDestinationAttachmentReservation,
  type PtyOwnershipTransferDestinationSnapshot
} from './pty-ownership-transfer-destination-adapter-contract'
import {
  assertSameCommitReceipt,
  validateFrame,
  validatePublicationReceipt,
  validateSurfaceBinding
} from './pty-ownership-transfer-destination-adapter-validation'
import { requireDestinationRecord } from './pty-ownership-transfer-destination-adapter-state'
import { snapshotDestinationTransfer } from './pty-ownership-transfer-destination-adapter-replay'

export function commitDestinationTransfer(
  state: DestinationAdapterState,
  receipt: PtyOwnershipTransferCommitReceipt
): PtyOwnershipTransferDestinationSnapshot {
  const record = requireDestinationRecord(state)
  if (record.phase === 'committed' || record.phase === 'published') {
    assertSameCommitReceipt(record.commitReceipt, receipt)
    return snapshotDestinationTransfer(state)
  }
  if (record.phase !== 'prepared') {
    throw new PtyOwnershipTransferDestinationError(
      'invalid-phase',
      `cannot commit destination while in ${record.phase}`
    )
  }
  const cursorMatches =
    receipt.acceptedSourceEndSeq === record.acceptedSourceEndSeq &&
    receipt.acceptedSourceEndSeq === record.sourceOutputEndSeq
  if (
    receipt.bridgeId !== record.identity.bridgeId ||
    !receipt.receiptId ||
    !Number.isFinite(Date.parse(receipt.committedAt))
  ) {
    throw new PtyOwnershipTransferDestinationError(
      'receipt-invalid',
      'commit receipt does not prove the exact destination and source cursors'
    )
  }
  if (!cursorMatches) {
    throw new PtyOwnershipTransferDestinationError(
      'destination-not-caught-up',
      'commit receipt does not prove the exact destination and source cursors'
    )
  }
  state.options.store.commit(record.identity, receipt)
  record.commitReceipt = structuredClone(receipt)
  record.phase = 'committed'
  record.liveOutputEndSeq = record.acceptedSourceEndSeq
  state.options.markPostCommitOutputBaseline?.(record.identity, record.liveOutputEndSeq)
  return snapshotDestinationTransfer(state)
}

export function publishDestinationTransfer(
  state: DestinationAdapterState
): PtyOwnershipTransferPublicationReceipt {
  const record = requireDestinationRecord(state)
  if (record.phase === 'published' && record.publicationReceipt) {
    return structuredClone(record.publicationReceipt)
  }
  if (record.phase !== 'committed' || !record.commitReceipt) {
    throw new PtyOwnershipTransferDestinationError(
      'invalid-phase',
      'destination publication requires a committed transfer'
    )
  }
  if (!record.surfaceBinding) {
    throw new PtyOwnershipTransferDestinationError(
      'surface-unbound',
      'destination publication requires a durable terminal surface binding'
    )
  }
  if (
    !record.surfacePublication ||
    !samePtyOwnershipTransferSurfaceBinding(
      record.surfaceBinding,
      record.surfacePublication.surfaceBinding
    )
  ) {
    throw new PtyOwnershipTransferDestinationError(
      'publication-invalid',
      'destination publication requires exact surface-publication negotiation'
    )
  }
  const reservedReceipt = state.options.store.reservePublication(
    record.identity,
    record.commitReceipt
  )
  validatePublicationReceipt(record, reservedReceipt)
  const publicationReceipt = state.options.publishDurably({
    identity: record.identity,
    surfaceBinding: record.surfaceBinding,
    frames: [...record.stagedFrames.values()].sort((left, right) => left.seq - right.seq),
    publicationReceipt: reservedReceipt
  })
  validatePublicationReceipt(record, publicationReceipt, reservedReceipt)
  state.options.store.publish(record.identity, publicationReceipt)
  record.publicationReceipt = structuredClone(publicationReceipt)
  record.phase = 'published'
  return structuredClone(publicationReceipt)
}

export function bindDestinationSurface(
  state: DestinationAdapterState,
  binding: PtyOwnershipTransferSurfaceBinding
): PtyOwnershipTransferDestinationSnapshot {
  const record = requireDestinationRecord(state)
  const validated = validateSurfaceBinding(binding)
  if (!record.surfacePublication) {
    throw new PtyOwnershipTransferDestinationError(
      'surface-unbound',
      'destination surface binding requires negotiated publication proof'
    )
  }
  if (
    !samePtyOwnershipTransferSurfaceBinding(validated, record.surfacePublication.surfaceBinding)
  ) {
    throw new PtyOwnershipTransferDestinationError(
      'surface-conflict',
      'destination surface binding does not match its negotiated publication surface'
    )
  }
  if (record.surfaceBinding) {
    if (!samePtyOwnershipTransferSurfaceBinding(record.surfaceBinding, validated)) {
      throw new PtyOwnershipTransferDestinationError(
        'surface-conflict',
        'destination transfer is already bound to a different terminal surface'
      )
    }
    return snapshotDestinationTransfer(state)
  }
  if (record.phase === 'published' || record.phase === 'aborted') {
    throw new PtyOwnershipTransferDestinationError(
      'invalid-phase',
      `cannot bind a destination surface while in ${record.phase}`
    )
  }
  const persisted = state.options.store.bindSurface(record.identity, validated)
  if (!samePtyOwnershipTransferSurfaceBinding(persisted, validated)) {
    throw new PtyOwnershipTransferDestinationError(
      'surface-conflict',
      'durable destination surface binding changed'
    )
  }
  record.surfaceBinding = persisted
  return snapshotDestinationTransfer(state)
}

export function acceptDestinationPostCommitOutput(
  state: DestinationAdapterState,
  frame: PtyOwnershipTransferOutputFrame,
  reservation?: PtyOwnershipTransferDestinationAttachmentReservation
): void {
  const record = requireDestinationRecord(state)
  if (record.phase !== 'committed' && record.phase !== 'published') {
    throw new PtyOwnershipTransferDestinationError(
      'invalid-phase',
      'post-commit output is unavailable before destination commit'
    )
  }
  if (!record.surfaceBinding) {
    throw new PtyOwnershipTransferDestinationError(
      'surface-unbound',
      'post-commit output requires a durable terminal surface binding'
    )
  }
  if (
    (record.pendingAttachment && record.pendingAttachment !== reservation) ||
    (!record.pendingAttachment && reservation)
  ) {
    throw new PtyOwnershipTransferDestinationError(
      'stale-attachment',
      'post-commit output does not match the current attachment generation'
    )
  }
  validateFrame(frame)
  if (frame.seq <= record.liveOutputEndSeq) {
    return
  }
  if (frame.seq !== record.liveOutputEndSeq + 1) {
    throw new PtyOwnershipTransferDestinationError(
      'output-gap',
      `expected post-commit output sequence ${record.liveOutputEndSeq + 1}, received ${frame.seq}`
    )
  }
  state.options.publishPostCommitOutput(record.identity, record.surfaceBinding, frame)
  record.liveOutputEndSeq = frame.seq
}

export function restoreDestinationPostCommitOutputBaseline(
  state: DestinationAdapterState,
  throughSeq: number
): PtyOwnershipTransferDestinationSnapshot {
  const record = requireDestinationRecord(state)
  if (record.phase !== 'committed' && record.phase !== 'published') {
    throw new PtyOwnershipTransferDestinationError(
      'invalid-phase',
      'post-commit output baseline is unavailable before destination commit'
    )
  }
  if (!Number.isSafeInteger(throughSeq) || throughSeq < 0) {
    throw new PtyOwnershipTransferDestinationError(
      'output-conflict',
      'post-commit output baseline sequence is invalid'
    )
  }
  if (throughSeq < record.liveOutputEndSeq) {
    return snapshotDestinationTransfer(state)
  }
  if (throughSeq < record.acceptedSourceEndSeq) {
    throw new PtyOwnershipTransferDestinationError(
      'output-conflict',
      'post-commit output baseline precedes the committed replay cursor'
    )
  }
  record.liveOutputEndSeq = throughSeq
  return snapshotDestinationTransfer(state)
}

export function abortDestinationTransfer(
  state: DestinationAdapterState
): PtyOwnershipTransferDestinationSnapshot {
  const record = requireDestinationRecord(state)
  if (record.phase === 'aborted') {
    return snapshotDestinationTransfer(state)
  }
  if (record.phase !== 'prepared') {
    throw new PtyOwnershipTransferDestinationError(
      'invalid-phase',
      `cannot abort destination while in ${record.phase}`
    )
  }
  state.options.store.abort(record.identity)
  record.phase = 'aborted'
  record.stagedFrames.clear()
  record.stagedOutputBytes = 0
  return snapshotDestinationTransfer(state)
}
