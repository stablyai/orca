import {
  parsePtyOwnershipTransferWireIdentity,
  PTY_OWNERSHIP_TRANSFER_WIRE_VERSION,
  type PtyOwnershipTransferWireIdentity
} from './pty-ownership-transfer-wire'
import {
  parsePtyOwnershipTransferExit,
  type PtyOwnershipTransferExecutionVerdict,
  type PtyOwnershipTransferExit
} from './pty-ownership-transfer-control-wire'

export type PtyOwnershipTransferReconnectRekeyRequest = PtyOwnershipTransferWireIdentity &
  Readonly<{
    version: typeof PTY_OWNERSHIP_TRANSFER_WIRE_VERSION
    previousReconnectGeneration: number
    reconnectGeneration: number
    attachmentId: string
  }>

export type PtyOwnershipTransferReconnectRekeyResult =
  PtyOwnershipTransferReconnectRekeyRequest &
    Readonly<{
      phase: 'committed' | 'published'
      executionVerdict: PtyOwnershipTransferExecutionVerdict
      exit?: PtyOwnershipTransferExit
    }>

export function parsePtyOwnershipTransferReconnectRekeyRequest(
  value: unknown
): PtyOwnershipTransferReconnectRekeyRequest {
  const record = requireVersionedRecord(value)
  const identity = parsePtyOwnershipTransferWireIdentity(record)
  const previousReconnectGeneration = requireGeneration(record.previousReconnectGeneration)
  const reconnectGeneration = requireGeneration(record.reconnectGeneration)
  if (
    previousReconnectGeneration < identity.sourceOwnerGeneration ||
    reconnectGeneration <= previousReconnectGeneration
  ) {
    throw new Error('pty_ownership_transfer_reconnect_rekey_generation_invalid')
  }
  return Object.freeze({
    ...identity,
    version: PTY_OWNERSHIP_TRANSFER_WIRE_VERSION,
    previousReconnectGeneration,
    reconnectGeneration,
    attachmentId: requireString(record.attachmentId)
  })
}

export function parsePtyOwnershipTransferReconnectRekeyResult(
  value: unknown
): PtyOwnershipTransferReconnectRekeyResult {
  const record = requireVersionedRecord(value)
  if (record.phase !== 'committed' && record.phase !== 'published') {
    throw new Error('pty_ownership_transfer_reconnect_rekey_phase_invalid')
  }
  const executionVerdict = record.executionVerdict
  if (
    executionVerdict !== 'live' &&
    executionVerdict !== 'unverifiable' &&
    executionVerdict !== 'exited'
  ) {
    throw new Error('pty_ownership_transfer_reconnect_rekey_verdict_invalid')
  }
  const exit = record.exit === undefined ? undefined : parsePtyOwnershipTransferExit(record.exit)
  if ((executionVerdict === 'exited') !== Boolean(exit)) {
    throw new Error('pty_ownership_transfer_reconnect_rekey_exit_invalid')
  }
  return Object.freeze({
    ...parsePtyOwnershipTransferReconnectRekeyRequest(record),
    phase: record.phase,
    executionVerdict,
    ...(exit ? { exit } : {})
  })
}

function requireVersionedRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('pty_ownership_transfer_reconnect_rekey_invalid')
  }
  const record = value as Record<string, unknown>
  if (record.version !== PTY_OWNERSHIP_TRANSFER_WIRE_VERSION) {
    throw new Error('pty_ownership_transfer_wire_version_unsupported')
  }
  return record
}

function requireGeneration(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new Error('pty_ownership_transfer_reconnect_rekey_generation_invalid')
  }
  return Number(value)
}

function requireString(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('pty_ownership_transfer_reconnect_rekey_attachment_invalid')
  }
  return value
}
