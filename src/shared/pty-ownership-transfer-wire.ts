import type {
  PtyOwnershipTransferCommitReceipt,
  PtyOwnershipTransferPublicationReceipt
} from './pty-ownership-transfer-journal-contract'
import {
  parsePtyOwnershipTransferCommitReceipt,
  parsePtyOwnershipTransferPublicationReceipt
} from './pty-ownership-transfer-receipt-wire'
import {
  parseOptionalPtyOwnershipTransferSurfacePublication,
  type PtyOwnershipTransferSurfacePublication
} from './pty-ownership-transfer-surface-publication'
import type { PtyOwnershipTransferOutputFrame } from './pty-ownership-transfer-output-wire'
import {
  parseOptionalPtyOwnershipTransferDestinationDelegation,
  type PtyOwnershipTransferDestinationDelegation
} from './pty-ownership-transfer-destination-delegation'

export {
  PTY_OWNERSHIP_TRANSFER_SURFACE_PUBLICATION_VERSION,
  type PtyOwnershipTransferSurfacePublication
} from './pty-ownership-transfer-surface-publication'
export {
  parsePtyOwnershipTransferCommitReceipt,
  parsePtyOwnershipTransferPublicationReceipt
} from './pty-ownership-transfer-receipt-wire'
export {
  parsePtyOwnershipTransferStatusRequest,
  type PtyOwnershipTransferStatusRequest,
  type PtyOwnershipTransferStatusResult
} from './pty-ownership-transfer-status-contract'
export {
  parsePtyOwnershipTransferOutputAcknowledgementRequest,
  parsePtyOwnershipTransferOutputCredit,
  parsePtyOwnershipTransferSourceStreamRequest,
  type PtyOwnershipTransferOutputAcknowledgementRequest,
  type PtyOwnershipTransferOutputAcknowledgementResult,
  type PtyOwnershipTransferOutputCredit,
  type PtyOwnershipTransferOutputFrame,
  type PtyOwnershipTransferSourceStreamEvent,
  type PtyOwnershipTransferSourceStreamRequest
} from './pty-ownership-transfer-output-wire'
/** Capability-gated additive RPCs; unknown methods never establish transfer failure. */
export const PTY_OWNERSHIP_TRANSFER_WIRE_VERSION = 1 as const

export const PTY_OWNERSHIP_TRANSFER_METHODS = Object.freeze({
  prepare: 'pty.ownershipTransfer.prepare',
  replay: 'pty.ownershipTransfer.replay',
  commit: 'pty.ownershipTransfer.commit',
  publish: 'pty.ownershipTransfer.publish',
  status: 'pty.ownershipTransfer.status',
  input: 'pty.ownershipTransfer.input',
  retireInput: 'pty.ownershipTransfer.retireInput',
  attach: 'pty.ownershipTransfer.attach',
  rekeyReconnect: 'pty.ownershipTransfer.rekeyReconnect',
  control: 'pty.ownershipTransfer.control',
  abort: 'pty.ownershipTransfer.abort',
  acknowledgeOutput: 'pty.ownershipTransfer.acknowledgeOutput'
})

export const PTY_OWNERSHIP_TRANSFER_NOTIFICATIONS = Object.freeze({
  exit: 'pty.ownershipTransfer.exit'
})

export type {
  PtyOwnershipTransferAttachmentRequest,
  PtyOwnershipTransferAttachmentResult,
  PtyOwnershipTransferControl,
  PtyOwnershipTransferControlRequest,
  PtyOwnershipTransferControlResult,
  PtyOwnershipTransferExecutionVerdict,
  PtyOwnershipTransferExit,
  PtyOwnershipTransferExitEvent
} from './pty-ownership-transfer-control-wire'

export type PtyOwnershipTransferWireIdentity = Readonly<{
  bridgeId: string
  terminalId: string
  incarnationId: string
  ownerLease: string
  sourceOwnerGeneration: number
  destinationRuntimeId: string
}>

export type PtyOwnershipTransferPrepareRequest = PtyOwnershipTransferWireIdentity &
  Readonly<{
    version: typeof PTY_OWNERSHIP_TRANSFER_WIRE_VERSION
    surfacePublication?: PtyOwnershipTransferSurfacePublication
    /** Requires separately negotiated destinationDelegationVersion support. */
    destinationDelegation?: PtyOwnershipTransferDestinationDelegation
  }>

export type PtyOwnershipTransferPrepareResult = PtyOwnershipTransferWireIdentity &
  Readonly<{
    version: typeof PTY_OWNERSHIP_TRANSFER_WIRE_VERSION
    phase: 'prepared'
    sourceOutputEndSeq: number
    replayStartSeq: number
    surfacePublication?: PtyOwnershipTransferSurfacePublication
    destinationDelegation?: PtyOwnershipTransferDestinationDelegation
  }>

export type PtyOwnershipTransferReplayRequest = PtyOwnershipTransferWireIdentity &
  Readonly<{
    version: typeof PTY_OWNERSHIP_TRANSFER_WIRE_VERSION
    afterSeq: number
    /** Required only for capability-negotiated post-commit replay after attachment rekey. */
    attachmentId?: string
  }>

export type PtyOwnershipTransferReplayResult = PtyOwnershipTransferWireIdentity &
  Readonly<{
    version: typeof PTY_OWNERSHIP_TRANSFER_WIRE_VERSION
    phase: 'prepared' | 'committed' | 'published'
    frames: readonly PtyOwnershipTransferOutputFrame[]
    sourceOutputEndSeq: number
    replayStartSeq: number
    attachmentId?: string
  }>

export type PtyOwnershipTransferCommitRequest = PtyOwnershipTransferWireIdentity &
  Readonly<{
    version: typeof PTY_OWNERSHIP_TRANSFER_WIRE_VERSION
    acceptedSourceEndSeq: number
    receipt: PtyOwnershipTransferCommitReceipt
  }>

export type PtyOwnershipTransferCommitResult = PtyOwnershipTransferWireIdentity &
  Readonly<{
    version: typeof PTY_OWNERSHIP_TRANSFER_WIRE_VERSION
    phase: 'committed'
    receipt: PtyOwnershipTransferCommitReceipt
  }>

export type PtyOwnershipTransferPublishRequest = PtyOwnershipTransferWireIdentity &
  Readonly<{
    version: typeof PTY_OWNERSHIP_TRANSFER_WIRE_VERSION
    publicationReceipt: PtyOwnershipTransferPublicationReceipt
  }>

export type PtyOwnershipTransferPublishResult = PtyOwnershipTransferWireIdentity &
  Readonly<{
    version: typeof PTY_OWNERSHIP_TRANSFER_WIRE_VERSION
    phase: 'published'
    publicationReceipt: PtyOwnershipTransferPublicationReceipt
  }>

export type PtyOwnershipTransferInputRequest = PtyOwnershipTransferWireIdentity &
  Readonly<{
    version: typeof PTY_OWNERSHIP_TRANSFER_WIRE_VERSION
    inputId: string
    data: string
  }>

export type PtyOwnershipTransferInputResult = Readonly<{
  accepted: boolean
  duplicate: boolean
}>

export type PtyOwnershipTransferRetireInputRequest = PtyOwnershipTransferWireIdentity &
  Readonly<{
    version: typeof PTY_OWNERSHIP_TRANSFER_WIRE_VERSION
    inputIds: readonly string[]
  }>

export type PtyOwnershipTransferRetireInputResult = Readonly<{ retired: number }>

export type PtyOwnershipTransferAbortRequest = PtyOwnershipTransferWireIdentity &
  Readonly<{ version: typeof PTY_OWNERSHIP_TRANSFER_WIRE_VERSION }>

export type PtyOwnershipTransferAbortResult = Readonly<{
  version: typeof PTY_OWNERSHIP_TRANSFER_WIRE_VERSION
  phase: 'aborted'
}>

export function parsePtyOwnershipTransferWireIdentity(
  value: unknown
): PtyOwnershipTransferWireIdentity {
  const record = requireRecord(value, 'pty_ownership_transfer_identity_invalid')
  return {
    bridgeId: requireString(record.bridgeId, 'pty_ownership_transfer_bridge_id_invalid'),
    terminalId: requireString(record.terminalId, 'pty_ownership_transfer_terminal_id_invalid'),
    incarnationId: requireString(
      record.incarnationId,
      'pty_ownership_transfer_incarnation_id_invalid'
    ),
    ownerLease: requireString(record.ownerLease, 'pty_ownership_transfer_owner_lease_invalid'),
    sourceOwnerGeneration: requireSequence(
      record.sourceOwnerGeneration,
      'pty_ownership_transfer_source_generation_invalid',
      1
    ),
    destinationRuntimeId: requireString(
      record.destinationRuntimeId,
      'pty_ownership_transfer_destination_runtime_invalid'
    )
  }
}

export function parsePtyOwnershipTransferPrepareRequest(
  value: unknown
): PtyOwnershipTransferPrepareRequest {
  const record = requireVersionedRecord(value)
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
    ...(surfacePublication ? { surfacePublication } : {}),
    ...(destinationDelegation ? { destinationDelegation } : {})
  })
}

export function parsePtyOwnershipTransferReplayRequest(
  value: unknown
): PtyOwnershipTransferReplayRequest {
  const record = requireVersionedRecord(value)
  const attachmentId =
    record.attachmentId === undefined
      ? undefined
      : requireString(record.attachmentId, 'pty_ownership_transfer_attachment_id_invalid')
  return Object.freeze({
    ...parsePtyOwnershipTransferWireIdentity(record),
    version: PTY_OWNERSHIP_TRANSFER_WIRE_VERSION,
    afterSeq: requireSequence(record.afterSeq, 'pty_ownership_transfer_after_seq_invalid'),
    ...(attachmentId ? { attachmentId } : {})
  })
}

export function parsePtyOwnershipTransferCommitRequest(
  value: unknown
): PtyOwnershipTransferCommitRequest {
  const record = requireVersionedRecord(value)
  const receipt = parsePtyOwnershipTransferCommitReceipt(record.receipt)
  const acceptedSourceEndSeq = requireSequence(
    record.acceptedSourceEndSeq,
    'pty_ownership_transfer_accepted_source_end_invalid'
  )
  if (receipt.acceptedSourceEndSeq !== acceptedSourceEndSeq) {
    throw new Error('pty_ownership_transfer_commit_cursor_mismatch')
  }
  return Object.freeze({
    ...parsePtyOwnershipTransferWireIdentity(record),
    version: PTY_OWNERSHIP_TRANSFER_WIRE_VERSION,
    acceptedSourceEndSeq,
    receipt
  })
}

export function parsePtyOwnershipTransferPublishRequest(
  value: unknown
): PtyOwnershipTransferPublishRequest {
  const record = requireVersionedRecord(value)
  const publicationReceipt = parsePtyOwnershipTransferPublicationReceipt(record.publicationReceipt)
  return Object.freeze({
    ...parsePtyOwnershipTransferWireIdentity(record),
    version: PTY_OWNERSHIP_TRANSFER_WIRE_VERSION,
    publicationReceipt
  })
}

export function parsePtyOwnershipTransferInputRequest(
  value: unknown
): PtyOwnershipTransferInputRequest {
  const record = requireVersionedRecord(value)
  return Object.freeze({
    ...parsePtyOwnershipTransferWireIdentity(record),
    version: PTY_OWNERSHIP_TRANSFER_WIRE_VERSION,
    inputId: requireString(record.inputId, 'pty_ownership_transfer_input_id_invalid'),
    data: requireString(record.data, 'pty_ownership_transfer_input_data_invalid', false)
  })
}

export function parsePtyOwnershipTransferRetireInputRequest(
  value: unknown
): PtyOwnershipTransferRetireInputRequest {
  const record = requireVersionedRecord(value)
  if (
    !Array.isArray(record.inputIds) ||
    record.inputIds.some((id) => typeof id !== 'string' || !id)
  ) {
    throw new Error('pty_ownership_transfer_input_ids_invalid')
  }
  return Object.freeze({
    ...parsePtyOwnershipTransferWireIdentity(record),
    version: PTY_OWNERSHIP_TRANSFER_WIRE_VERSION,
    inputIds: Object.freeze(record.inputIds.slice())
  })
}

export function parsePtyOwnershipTransferAbortRequest(
  value: unknown
): PtyOwnershipTransferAbortRequest {
  const record = requireVersionedRecord(value)
  return Object.freeze({
    ...parsePtyOwnershipTransferWireIdentity(record),
    version: PTY_OWNERSHIP_TRANSFER_WIRE_VERSION
  })
}

function requireVersionedRecord(value: unknown): Record<string, unknown> {
  const record = requireRecord(value, 'pty_ownership_transfer_request_invalid')
  if (record.version !== PTY_OWNERSHIP_TRANSFER_WIRE_VERSION) {
    throw new Error('pty_ownership_transfer_wire_version_unsupported')
  }
  return record
}

function requireRecord(value: unknown, code: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(code)
  }
  return value as Record<string, unknown>
}

function requireString(value: unknown, code: string, nonEmpty = true): string {
  if (typeof value !== 'string' || (nonEmpty && value.length === 0)) {
    throw new Error(code)
  }
  return value
}

function requireSequence(value: unknown, code: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) {
    throw new Error(code)
  }
  return Number(value)
}
