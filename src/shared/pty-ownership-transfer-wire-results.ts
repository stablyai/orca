import {
  parsePtyOwnershipTransferCommitReceipt,
  parsePtyOwnershipTransferPublicationReceipt,
  parsePtyOwnershipTransferWireIdentity,
  PTY_OWNERSHIP_TRANSFER_WIRE_VERSION,
  type PtyOwnershipTransferCommitResult,
  type PtyOwnershipTransferInputResult,
  type PtyOwnershipTransferOutputFrame,
  type PtyOwnershipTransferPrepareResult,
  type PtyOwnershipTransferPublishResult,
  type PtyOwnershipTransferReplayResult,
  type PtyOwnershipTransferRetireInputResult,
  type PtyOwnershipTransferAbortResult,
  type PtyOwnershipTransferStatusResult
} from './pty-ownership-transfer-wire'
import { parseOptionalPtyOwnershipTransferSurfacePublication } from './pty-ownership-transfer-surface-publication'
import { parsePtyOwnershipTransferExit } from './pty-ownership-transfer-control-wire'

import { parseOptionalPtyOwnershipTransferDestinationDelegation } from './pty-ownership-transfer-destination-delegation'

export function parsePtyOwnershipTransferPrepareResult(
  value: unknown
): PtyOwnershipTransferPrepareResult {
  const record = requireVersionedRecord(value)
  requirePhase(record, 'prepared')
  const surfacePublication = parseOptionalPtyOwnershipTransferSurfacePublication(
    record.surfacePublication
  )
  const destinationDelegation = parseOptionalPtyOwnershipTransferDestinationDelegation(
    record.destinationDelegation,
    surfacePublication
  )
  return Object.freeze({
    ...parsePtyOwnershipTransferWireIdentity(record),
    version: PTY_OWNERSHIP_TRANSFER_WIRE_VERSION,
    phase: 'prepared',
    sourceOutputEndSeq: requireSequence(record.sourceOutputEndSeq),
    replayStartSeq: requireSequence(record.replayStartSeq),
    ...(surfacePublication ? { surfacePublication } : {}),
    ...(destinationDelegation ? { destinationDelegation } : {})
  })
}

export function parsePtyOwnershipTransferReplayResult(
  value: unknown
): PtyOwnershipTransferReplayResult {
  const record = requireVersionedRecord(value)
  const phase = record.phase
  if (phase !== 'prepared' && phase !== 'committed' && phase !== 'published') {
    throw new Error('pty_ownership_transfer_result_phase_invalid')
  }
  if (!Array.isArray(record.frames)) {
    throw new Error('pty_ownership_transfer_replay_result_frames_invalid')
  }
  const attachmentId =
    record.attachmentId === undefined ? undefined : requireNonEmptyString(record.attachmentId)
  if ((phase === 'prepared') === Boolean(attachmentId)) {
    throw new Error('pty_ownership_transfer_replay_result_attachment_invalid')
  }
  return Object.freeze({
    ...parsePtyOwnershipTransferWireIdentity(record),
    version: PTY_OWNERSHIP_TRANSFER_WIRE_VERSION,
    phase,
    frames: Object.freeze(record.frames.map(parseOutputFrame)),
    sourceOutputEndSeq: requireSequence(record.sourceOutputEndSeq),
    replayStartSeq: requireSequence(record.replayStartSeq),
    ...(attachmentId ? { attachmentId } : {})
  })
}

export function parsePtyOwnershipTransferCommitResult(
  value: unknown
): PtyOwnershipTransferCommitResult {
  const record = requireVersionedRecord(value)
  requirePhase(record, 'committed')
  return Object.freeze({
    ...parsePtyOwnershipTransferWireIdentity(record),
    version: PTY_OWNERSHIP_TRANSFER_WIRE_VERSION,
    phase: 'committed',
    receipt: parsePtyOwnershipTransferCommitReceipt(record.receipt)
  })
}

export function parsePtyOwnershipTransferPublishResult(
  value: unknown
): PtyOwnershipTransferPublishResult {
  const record = requireVersionedRecord(value)
  requirePhase(record, 'published')
  return Object.freeze({
    ...parsePtyOwnershipTransferWireIdentity(record),
    version: PTY_OWNERSHIP_TRANSFER_WIRE_VERSION,
    phase: 'published',
    publicationReceipt: parsePtyOwnershipTransferPublicationReceipt(record.publicationReceipt)
  })
}

export function parsePtyOwnershipTransferInputResult(
  value: unknown
): PtyOwnershipTransferInputResult {
  const record = requireRecord(value)
  if (typeof record.accepted !== 'boolean' || typeof record.duplicate !== 'boolean') {
    throw new Error('pty_ownership_transfer_input_result_invalid')
  }
  return Object.freeze({ accepted: record.accepted, duplicate: record.duplicate })
}

export function parsePtyOwnershipTransferRetireInputResult(
  value: unknown
): PtyOwnershipTransferRetireInputResult {
  const record = requireRecord(value)
  if (!Number.isSafeInteger(record.retired) || Number(record.retired) < 0) {
    throw new Error('pty_ownership_transfer_retire_input_result_invalid')
  }
  return Object.freeze({ retired: Number(record.retired) })
}

export function parsePtyOwnershipTransferAbortResult(
  value: unknown
): PtyOwnershipTransferAbortResult {
  const record = requireRecord(value)
  if (record.version !== PTY_OWNERSHIP_TRANSFER_WIRE_VERSION || record.phase !== 'aborted') {
    throw new Error('pty_ownership_transfer_abort_result_invalid')
  }
  return Object.freeze({ version: PTY_OWNERSHIP_TRANSFER_WIRE_VERSION, phase: 'aborted' })
}

export function parsePtyOwnershipTransferStatusResult(
  value: unknown
): PtyOwnershipTransferStatusResult {
  const record = requireVersionedRecord(value)
  const identity = parsePtyOwnershipTransferWireIdentity(record)
  const phase = record.phase
  if (
    phase !== 'prepared' &&
    phase !== 'committed' &&
    phase !== 'published' &&
    phase !== 'aborted'
  ) {
    throw new Error('pty_ownership_transfer_status_result_phase_invalid')
  }
  const sourceOutputEndSeq = requireSequence(record.sourceOutputEndSeq)
  const replayStartSeq = requireSequence(record.replayStartSeq)
  const acceptedSourceEndSeq = requireSequence(record.acceptedSourceEndSeq)
  const acceptedInputIds = record.acceptedInputIds
  if (!Number.isSafeInteger(acceptedInputIds) || Number(acceptedInputIds) < 0) {
    throw new Error('pty_ownership_transfer_status_result_input_count_invalid')
  }
  const reconnectGeneration =
    record.reconnectGeneration === undefined
      ? undefined
      : requirePositiveGeneration(record.reconnectGeneration)
  if (reconnectGeneration !== undefined && reconnectGeneration < identity.sourceOwnerGeneration) {
    throw new Error('pty_ownership_transfer_status_result_reconnect_generation_invalid')
  }
  if (acceptedSourceEndSeq > sourceOutputEndSeq) {
    throw new Error('pty_ownership_transfer_status_result_cursor_invalid')
  }
  const commitReceipt =
    record.commitReceipt === undefined
      ? undefined
      : parsePtyOwnershipTransferCommitReceipt(record.commitReceipt)
  const publicationReceipt =
    record.publicationReceipt === undefined
      ? undefined
      : parsePtyOwnershipTransferPublicationReceipt(record.publicationReceipt)
  const surfacePublication = parseOptionalPtyOwnershipTransferSurfacePublication(
    record.surfacePublication
  )
  const exit = record.exit === undefined ? undefined : parsePtyOwnershipTransferExit(record.exit)
  const destinationDelegation = parseOptionalPtyOwnershipTransferDestinationDelegation(
    record.destinationDelegation,
    surfacePublication
  )
  if ((phase === 'committed' || phase === 'published') !== Boolean(commitReceipt)) {
    throw new Error('pty_ownership_transfer_status_result_commit_phase_invalid')
  }
  if ((phase === 'published') !== Boolean(publicationReceipt)) {
    throw new Error('pty_ownership_transfer_status_result_publication_phase_invalid')
  }
  if (
    commitReceipt &&
    (commitReceipt.bridgeId !== identity.bridgeId ||
      commitReceipt.acceptedSourceEndSeq !== acceptedSourceEndSeq)
  ) {
    throw new Error('pty_ownership_transfer_status_result_commit_identity_invalid')
  }
  if (
    publicationReceipt &&
    (publicationReceipt.bridgeId !== identity.bridgeId ||
      publicationReceipt.destinationRuntimeId !== identity.destinationRuntimeId ||
      publicationReceipt.commitReceipt.bridgeId !== identity.bridgeId ||
      publicationReceipt.commitReceipt.acceptedSourceEndSeq !== acceptedSourceEndSeq)
  ) {
    throw new Error('pty_ownership_transfer_status_result_publication_identity_invalid')
  }
  return Object.freeze({
    ...identity,
    version: PTY_OWNERSHIP_TRANSFER_WIRE_VERSION,
    phase,
    sourceOutputEndSeq,
    replayStartSeq,
    acceptedSourceEndSeq,
    acceptedInputIds: Number(acceptedInputIds),
    ...(destinationDelegation ? { destinationDelegation } : {}),
    ...(reconnectGeneration === undefined ? {} : { reconnectGeneration }),
    ...(commitReceipt ? { commitReceipt } : {}),
    ...(publicationReceipt ? { publicationReceipt } : {}),
    ...(surfacePublication ? { surfacePublication } : {}),
    ...(exit ? { exit } : {})
  })
}

function requirePositiveGeneration(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new Error('pty_ownership_transfer_status_result_reconnect_generation_invalid')
  }
  return Number(value)
}

export function parseOutputFrame(value: unknown): PtyOwnershipTransferOutputFrame {
  const record = requireRecord(value)
  if (
    !Number.isSafeInteger(record.seq) ||
    Number(record.seq) < 0 ||
    typeof record.data !== 'string' ||
    record.data.length === 0 ||
    (record.truncated !== undefined && record.truncated !== true)
  ) {
    throw new Error('pty_ownership_transfer_output_frame_invalid')
  }
  return Object.freeze({
    seq: Number(record.seq),
    data: record.data,
    ...(record.truncated === true ? { truncated: true } : {})
  })
}

function requireVersionedRecord(value: unknown): Record<string, unknown> {
  const record = requireRecord(value)
  if (record.version !== PTY_OWNERSHIP_TRANSFER_WIRE_VERSION) {
    throw new Error('pty_ownership_transfer_wire_version_unsupported')
  }
  return record
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('pty_ownership_transfer_result_invalid')
  }
  return value as Record<string, unknown>
}

function requirePhase(record: Record<string, unknown>, phase: string): void {
  if (record.phase !== phase) {
    throw new Error('pty_ownership_transfer_result_phase_invalid')
  }
}

function requireSequence(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error('pty_ownership_transfer_result_sequence_invalid')
  }
  return Number(value)
}

function requireNonEmptyString(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('pty_ownership_transfer_result_string_invalid')
  }
  return value
}
