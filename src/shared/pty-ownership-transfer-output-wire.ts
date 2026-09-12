import type { PtyOwnershipTransferExitEvent } from './pty-ownership-transfer-control-wire'
import {
  parsePtyOwnershipTransferWireIdentity,
  type PtyOwnershipTransferWireIdentity
} from './pty-ownership-transfer-wire'

export type PtyOwnershipTransferOutputFrame = Readonly<{
  seq: number
  data: string
  truncated?: boolean
}>

export type PtyOwnershipTransferOutputCredit = Readonly<{
  version: 1
  windowBytes: number
  windowFrames: number
}>

export type PtyOwnershipTransferSourceStreamRequest = PtyOwnershipTransferWireIdentity &
  Readonly<{
    version: 1
    attachmentId: string
    outputCredit?: PtyOwnershipTransferOutputCredit
  }>

export type PtyOwnershipTransferOutputAcknowledgementRequest = PtyOwnershipTransferWireIdentity &
  Readonly<{
    version: 1
    attachmentId: string
    throughSeq: number
  }>

export type PtyOwnershipTransferOutputAcknowledgementResult = Readonly<{
  version: 1
  identity: PtyOwnershipTransferWireIdentity
  attachmentId: string
  throughSeq: number
}>

export type PtyOwnershipTransferSourceStreamEvent =
  | Readonly<{
      kind: 'ready'
      identity: PtyOwnershipTransferWireIdentity
      attachmentId: string
      outputCredit?: PtyOwnershipTransferOutputCredit
    }>
  | Readonly<{
      kind: 'output'
      identity: PtyOwnershipTransferWireIdentity
      attachmentId: string
      frame: PtyOwnershipTransferOutputFrame
    }>
  | Readonly<{ kind: 'exit'; event: PtyOwnershipTransferExitEvent }>
  | Readonly<{ kind: 'loss'; code: string }>

export function parsePtyOwnershipTransferSourceStreamRequest(
  value: unknown
): PtyOwnershipTransferSourceStreamRequest {
  const record = requireVersionedRecord(value)
  const outputCredit =
    record.outputCredit === undefined
      ? undefined
      : parsePtyOwnershipTransferOutputCredit(record.outputCredit)
  return Object.freeze({
    ...parsePtyOwnershipTransferWireIdentity(record),
    version: 1,
    attachmentId: requireString(record.attachmentId),
    ...(outputCredit ? { outputCredit } : {})
  })
}

export function parsePtyOwnershipTransferOutputAcknowledgementRequest(
  value: unknown
): PtyOwnershipTransferOutputAcknowledgementRequest {
  const record = requireVersionedRecord(value)
  return Object.freeze({
    ...parsePtyOwnershipTransferWireIdentity(record),
    version: 1,
    attachmentId: requireString(record.attachmentId),
    throughSeq: requireSequence(record.throughSeq)
  })
}

export function parsePtyOwnershipTransferOutputCredit(
  value: unknown
): PtyOwnershipTransferOutputCredit {
  const record = requireRecord(value, 'pty_ownership_transfer_output_credit_invalid')
  if (
    record.version !== 1 ||
    !Number.isSafeInteger(record.windowBytes) ||
    Number(record.windowBytes) <= 0 ||
    Number(record.windowBytes) > 2 * 1024 * 1024 ||
    !Number.isSafeInteger(record.windowFrames) ||
    Number(record.windowFrames) <= 0 ||
    Number(record.windowFrames) > 1_024
  ) {
    throw new Error('pty_ownership_transfer_output_credit_invalid')
  }
  return Object.freeze({
    version: 1,
    windowBytes: Number(record.windowBytes),
    windowFrames: Number(record.windowFrames)
  })
}

function requireVersionedRecord(value: unknown): Record<string, unknown> {
  const record = requireRecord(value, 'pty_ownership_transfer_request_invalid')
  if (record.version !== 1) {
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

function requireString(value: unknown): string {
  if (typeof value !== 'string' || !value) {
    throw new Error('pty_ownership_transfer_attachment_id_invalid')
  }
  return value
}

function requireSequence(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error('pty_ownership_transfer_ack_seq_invalid')
  }
  return Number(value)
}
