import type {
  PtyOwnershipTransferPrepareResult,
  PtyOwnershipTransferReplayResult,
  PtyOwnershipTransferOutputFrame
} from './pty-ownership-transfer-wire'
import {
  PTY_OWNERSHIP_TRANSFER_DESTINATION_MAX_STAGED_BYTES,
  PtyOwnershipTransferDestinationError,
  type DestinationAdapterState,
  type DestinationRecord,
  type PtyOwnershipTransferDestinationSnapshot
} from './pty-ownership-transfer-destination-adapter-contract'
import {
  assertJournalIdentity,
  bytesOf,
  identityFrom,
  validateFrame,
  validatePrepareResult,
  validateReplayResult,
  validateSurfaceBinding,
  validateSurfacePublication
} from './pty-ownership-transfer-destination-adapter-validation'
import { requireDestinationRecord } from './pty-ownership-transfer-destination-adapter-state'
import { samePtyOwnershipTransferSurfaceBinding } from './pty-ownership-transfer-surface-binding'

export function prepareDestinationTransfer(
  state: DestinationAdapterState,
  result: PtyOwnershipTransferPrepareResult
): PtyOwnershipTransferDestinationSnapshot {
  validatePrepareResult(result)
  const identity = identityFrom(result)
  const existing = state.options.store.load(identity)
  if (existing?.phase === 'aborted') {
    throw new PtyOwnershipTransferDestinationError(
      'invalid-phase',
      'an aborted destination transfer cannot be reused'
    )
  }
  if (existing) {
    assertJournalIdentity(existing, identity)
  }
  const journal = existing ?? state.options.store.prepare(identity, result.replayStartSeq - 1)
  if (journal.acceptedSourceEndSeq > result.sourceOutputEndSeq) {
    throw new PtyOwnershipTransferDestinationError(
      'identity-mismatch',
      'destination cursor is ahead of the advertised source cursor'
    )
  }
  const stagedFrames = loadFrames(state, identity, journal.acceptedSourceEndSeq)
  const storedSurfaceBinding = state.options.store.loadSurfaceBinding(identity)
  const surfaceBinding = storedSurfaceBinding
    ? validateSurfaceBinding(storedSurfaceBinding)
    : undefined
  const surfacePublication = validateSurfacePublication(result.surfacePublication)
  if (
    surfaceBinding &&
    !samePtyOwnershipTransferSurfaceBinding(surfaceBinding, surfacePublication?.surfaceBinding)
  ) {
    throw new PtyOwnershipTransferDestinationError(
      'surface-conflict',
      'durable destination surface does not match prepare negotiation'
    )
  }
  const inputEntries = state.options.store.loadInputIds(identity)
  if (inputEntries.length > state.inputIds) {
    throw new PtyOwnershipTransferDestinationError(
      'output-conflict',
      'durable destination input deduplication state exceeded its bound'
    )
  }
  const acceptedInputIds = new Map<string, string>()
  for (const entry of inputEntries) {
    if (!entry.inputId || typeof entry.data !== 'string') {
      throw new PtyOwnershipTransferDestinationError(
        'output-conflict',
        'durable destination input deduplication state is malformed'
      )
    }
    acceptedInputIds.set(entry.inputId, entry.data)
  }
  state.record = {
    identity: Object.freeze({ ...identity }),
    phase: journal.phase,
    sourceOutputEndSeq: result.sourceOutputEndSeq,
    replayStartSeq: result.replayStartSeq,
    acceptedSourceEndSeq: journal.acceptedSourceEndSeq,
    stagedFrames,
    stagedOutputBytes: bytesOf(stagedFrames.values()),
    acceptedInputIds,
    ...(journal.receipt ? { commitReceipt: structuredClone(journal.receipt) } : {}),
    ...(journal.publicationReceipt
      ? { publicationReceipt: structuredClone(journal.publicationReceipt) }
      : {}),
    ...(surfaceBinding ? { surfaceBinding } : {}),
    ...(surfacePublication ? { surfacePublication } : {}),
    liveOutputEndSeq: journal.acceptedSourceEndSeq,
    nextAttachmentGeneration: 1,
    executionVerdict: 'unverifiable'
  }
  return snapshotDestinationTransfer(state)
}

export function acceptDestinationReplay(
  state: DestinationAdapterState,
  result: PtyOwnershipTransferReplayResult
): PtyOwnershipTransferDestinationSnapshot {
  validateReplayResult(result)
  const record = requireDestinationRecord(state, result)
  if (record.phase !== 'prepared') {
    throw new PtyOwnershipTransferDestinationError(
      'invalid-phase',
      `cannot accept replay while destination is ${record.phase}`
    )
  }
  const firstFrame = result.frames[0]
  if (firstFrame && firstFrame.seq > record.acceptedSourceEndSeq + 1) {
    throw new PtyOwnershipTransferDestinationError(
      'output-gap',
      `expected output sequence ${record.acceptedSourceEndSeq + 1}, received ${firstFrame.seq}`
    )
  }
  record.sourceOutputEndSeq = result.sourceOutputEndSeq
  record.replayStartSeq = result.replayStartSeq
  for (const frame of result.frames) {
    acceptDestinationReplayFrame(state, frame)
  }
  return snapshotDestinationTransfer(state)
}

export function acceptDestinationReplayFrame(
  state: DestinationAdapterState,
  frame: PtyOwnershipTransferOutputFrame
): PtyOwnershipTransferDestinationSnapshot {
  const record = requireDestinationRecord(state)
  if (record.phase !== 'prepared') {
    throw new PtyOwnershipTransferDestinationError(
      'invalid-phase',
      `cannot accept replay while destination is ${record.phase}`
    )
  }
  validateFrame(frame)
  if (frame.seq > record.sourceOutputEndSeq) {
    throw new PtyOwnershipTransferDestinationError(
      'output-conflict',
      `output sequence ${frame.seq} exceeds the advertised source cursor ${record.sourceOutputEndSeq}`
    )
  }
  if (frame.seq <= record.acceptedSourceEndSeq) {
    const existing = record.stagedFrames.get(frame.seq)
    if (!existing || existing.data !== frame.data) {
      throw new PtyOwnershipTransferDestinationError(
        'output-conflict',
        `output sequence ${frame.seq} changed or is no longer durable`
      )
    }
    return snapshotDestinationTransfer(state)
  }
  const expected = record.acceptedSourceEndSeq + 1
  if (frame.seq !== expected) {
    throw new PtyOwnershipTransferDestinationError(
      'output-gap',
      `expected output sequence ${expected}, received ${frame.seq}`
    )
  }
  const frameBytes = Buffer.byteLength(frame.data, 'utf8')
  if (record.stagedOutputBytes + frameBytes > PTY_OWNERSHIP_TRANSFER_DESTINATION_MAX_STAGED_BYTES) {
    throw new PtyOwnershipTransferDestinationError(
      'output-conflict',
      'staged destination output exceeded its bounded transfer window'
    )
  }
  state.options.store.appendFrame(record.identity, frame)
  record.stagedFrames.set(frame.seq, Object.freeze({ ...frame }))
  record.acceptedSourceEndSeq = frame.seq
  record.stagedOutputBytes += frameBytes
  return snapshotDestinationTransfer(state)
}

function loadFrames(
  state: DestinationAdapterState,
  identity: DestinationRecord['identity'],
  acceptedSourceEndSeq: number
): Map<number, PtyOwnershipTransferOutputFrame> {
  const frames = state.options.store.loadFrames(identity)
  const map = new Map<number, PtyOwnershipTransferOutputFrame>()
  let expected = acceptedSourceEndSeq - frames.length + 1
  for (const frame of frames) {
    validateFrame(frame)
    if (frame.seq !== expected) {
      throw new PtyOwnershipTransferDestinationError(
        'output-conflict',
        'durable destination frames are not contiguous'
      )
    }
    map.set(frame.seq, Object.freeze({ ...frame }))
    expected++
  }
  if (frames.length > 0 && expected !== acceptedSourceEndSeq + 1) {
    throw new PtyOwnershipTransferDestinationError(
      'output-conflict',
      'durable destination cursor does not match staged frames'
    )
  }
  return map
}

export function snapshotDestinationTransfer(
  state: DestinationAdapterState
): PtyOwnershipTransferDestinationSnapshot {
  const record = requireDestinationRecord(state)
  return Object.freeze({
    phase: record.phase,
    identity: record.identity,
    sourceOutputEndSeq: record.sourceOutputEndSeq,
    acceptedSourceEndSeq: record.acceptedSourceEndSeq,
    stagedOutputFrames: record.stagedFrames.size,
    stagedOutputBytes: record.stagedOutputBytes,
    acceptedInputIds: record.acceptedInputIds.size,
    liveOutputEndSeq: record.liveOutputEndSeq,
    executionVerdict: record.executionVerdict,
    ...(record.delegatedClaim
      ? {
          delegatedClaim: Object.freeze({ ...record.delegatedClaim }),
          delegatedClaimActive: record.delegatedClaimActive === true
        }
      : {}),
    ...(record.attachmentId ? { attachmentId: record.attachmentId } : {}),
    ...(record.attachmentGeneration === undefined
      ? {}
      : { attachmentGeneration: record.attachmentGeneration }),
    ...(record.exit ? { exit: structuredClone(record.exit) } : {}),
    ...(record.surfaceBinding ? { surfaceBinding: record.surfaceBinding } : {}),
    ...(record.commitReceipt ? { commitReceipt: structuredClone(record.commitReceipt) } : {}),
    ...(record.publicationReceipt
      ? { publicationReceipt: structuredClone(record.publicationReceipt) }
      : {})
  })
}
