import {
  parsePtyOwnershipTransferWireIdentity,
  PTY_OWNERSHIP_TRANSFER_WIRE_VERSION,
  type PtyOwnershipTransferWireIdentity
} from './pty-ownership-transfer-wire'

export type PtyOwnershipTransferExecutionVerdict = 'live' | 'unverifiable' | 'exited'

export type PtyOwnershipTransferAttachmentRequest = PtyOwnershipTransferWireIdentity &
  Readonly<{
    version: typeof PTY_OWNERSHIP_TRANSFER_WIRE_VERSION
    attachmentId: string
  }>

export type PtyOwnershipTransferExit = Readonly<{
  verdict: 'exited'
  eventId: string
  observedAt: string
  code?: number
}>

export type PtyOwnershipTransferAttachmentResult = PtyOwnershipTransferWireIdentity &
  Readonly<{
    version: typeof PTY_OWNERSHIP_TRANSFER_WIRE_VERSION
    phase: 'prepared' | 'committed' | 'published'
    attachmentId: string
    executionVerdict: PtyOwnershipTransferExecutionVerdict
    exit?: PtyOwnershipTransferExit
  }>

export type PtyOwnershipTransferControl =
  | Readonly<{ kind: 'resize'; cols: number; rows: number }>
  | Readonly<{ kind: 'sendSignal'; signal: string }>
  | Readonly<{ kind: 'clearBuffer' }>
  | Readonly<{ kind: 'shutdown'; immediate: boolean }>

export type PtyOwnershipTransferControlRequest = PtyOwnershipTransferAttachmentRequest &
  Readonly<{
    controlId: string
    control: PtyOwnershipTransferControl
  }>

export type PtyOwnershipTransferControlResult = PtyOwnershipTransferWireIdentity &
  Readonly<{
    version: typeof PTY_OWNERSHIP_TRANSFER_WIRE_VERSION
    attachmentId: string
    controlId: string
    outcome: 'applied' | 'unverifiable'
    duplicate: boolean
  }>

export type PtyOwnershipTransferExitEvent = PtyOwnershipTransferWireIdentity &
  Readonly<{
    version: typeof PTY_OWNERSHIP_TRANSFER_WIRE_VERSION
    attachmentId: string
    exit: PtyOwnershipTransferExit
  }>

export function parsePtyOwnershipTransferAttachmentRequest(
  value: unknown
): PtyOwnershipTransferAttachmentRequest {
  const record = requireVersionedRecord(value)
  return Object.freeze({
    ...parsePtyOwnershipTransferWireIdentity(record),
    version: PTY_OWNERSHIP_TRANSFER_WIRE_VERSION,
    attachmentId: requireString(record.attachmentId, 'attachment_id')
  })
}

export function parsePtyOwnershipTransferControlRequest(
  value: unknown
): PtyOwnershipTransferControlRequest {
  const record = requireVersionedRecord(value)
  return Object.freeze({
    ...parsePtyOwnershipTransferAttachmentRequest(record),
    controlId: requireString(record.controlId, 'control_id'),
    control: parseControl(record.control)
  })
}

export function parsePtyOwnershipTransferAttachmentResult(
  value: unknown
): PtyOwnershipTransferAttachmentResult {
  const record = requireVersionedRecord(value)
  const phase = record.phase
  const executionVerdict = record.executionVerdict
  if (phase !== 'prepared' && phase !== 'committed' && phase !== 'published') {
    throw new Error('pty_ownership_transfer_attachment_phase_invalid')
  }
  if (
    executionVerdict !== 'live' &&
    executionVerdict !== 'unverifiable' &&
    executionVerdict !== 'exited'
  ) {
    throw new Error('pty_ownership_transfer_attachment_verdict_invalid')
  }
  const exit = record.exit === undefined ? undefined : parsePtyOwnershipTransferExit(record.exit)
  if ((executionVerdict === 'exited') !== Boolean(exit)) {
    throw new Error('pty_ownership_transfer_attachment_exit_invalid')
  }
  return Object.freeze({
    ...parsePtyOwnershipTransferWireIdentity(record),
    version: PTY_OWNERSHIP_TRANSFER_WIRE_VERSION,
    phase,
    attachmentId: requireString(record.attachmentId, 'attachment_id'),
    executionVerdict,
    ...(exit ? { exit } : {})
  })
}

export function parsePtyOwnershipTransferControlResult(
  value: unknown
): PtyOwnershipTransferControlResult {
  const record = requireVersionedRecord(value)
  if (
    (record.outcome !== 'applied' && record.outcome !== 'unverifiable') ||
    typeof record.duplicate !== 'boolean'
  ) {
    throw new Error('pty_ownership_transfer_control_result_invalid')
  }
  return Object.freeze({
    ...parsePtyOwnershipTransferWireIdentity(record),
    version: PTY_OWNERSHIP_TRANSFER_WIRE_VERSION,
    attachmentId: requireString(record.attachmentId, 'attachment_id'),
    controlId: requireString(record.controlId, 'control_id'),
    outcome: record.outcome,
    duplicate: record.duplicate
  })
}

export function parsePtyOwnershipTransferExitEvent(value: unknown): PtyOwnershipTransferExitEvent {
  const record = requireVersionedRecord(value)
  return Object.freeze({
    ...parsePtyOwnershipTransferWireIdentity(record),
    version: PTY_OWNERSHIP_TRANSFER_WIRE_VERSION,
    attachmentId: requireString(record.attachmentId, 'attachment_id'),
    exit: parsePtyOwnershipTransferExit(record.exit)
  })
}

export function parseControl(value: unknown): PtyOwnershipTransferControl {
  const record = requireRecord(value, 'control')
  if (record.kind === 'resize') {
    return Object.freeze({
      kind: 'resize',
      cols: requireDimension(record.cols),
      rows: requireDimension(record.rows)
    })
  }
  if (record.kind === 'sendSignal') {
    return Object.freeze({ kind: 'sendSignal', signal: requireString(record.signal, 'signal') })
  }
  if (record.kind === 'clearBuffer') {
    return Object.freeze({ kind: 'clearBuffer' })
  }
  if (record.kind === 'shutdown' && typeof record.immediate === 'boolean') {
    return Object.freeze({ kind: 'shutdown', immediate: record.immediate })
  }
  throw new Error('pty_ownership_transfer_control_invalid')
}

export function parsePtyOwnershipTransferExit(value: unknown): PtyOwnershipTransferExit {
  const record = requireRecord(value, 'exit')
  if (
    record.verdict !== 'exited' ||
    typeof record.observedAt !== 'string' ||
    !Number.isFinite(Date.parse(record.observedAt)) ||
    (record.code !== undefined && !Number.isSafeInteger(record.code))
  ) {
    throw new Error('pty_ownership_transfer_exit_invalid')
  }
  return Object.freeze({
    verdict: 'exited',
    eventId: requireString(record.eventId, 'exit_event_id'),
    observedAt: record.observedAt,
    ...(record.code === undefined ? {} : { code: Number(record.code) })
  })
}

function requireVersionedRecord(value: unknown): Record<string, unknown> {
  const record = requireRecord(value, 'request')
  if (record.version !== PTY_OWNERSHIP_TRANSFER_WIRE_VERSION) {
    throw new Error('pty_ownership_transfer_wire_version_unsupported')
  }
  return record
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`pty_ownership_transfer_${field}_invalid`)
  }
  return value as Record<string, unknown>
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`pty_ownership_transfer_${field}_invalid`)
  }
  return value
}

function requireDimension(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > 500) {
    throw new Error('pty_ownership_transfer_dimension_invalid')
  }
  return Number(value)
}
