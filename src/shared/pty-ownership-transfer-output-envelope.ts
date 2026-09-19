import type { PtyOwnershipTransferWireIdentity } from './pty-ownership-transfer-wire'
import { PTY_OWNERSHIP_TRANSFER_WIRE_VERSION } from './pty-ownership-transfer-wire'

/**
 * Optional metadata carried on an existing credited `pty.data` frame.
 *
 * The envelope identifies the ownership bridge and the position of this frame's
 * fragment within the complete transfer frame. It is deliberately additive so
 * older clients continue to process the surrounding `pty.data` payload.
 */
export type PtyOwnershipTransferOutputEnvelope = PtyOwnershipTransferWireIdentity &
  Readonly<{
    version: typeof PTY_OWNERSHIP_TRANSFER_WIRE_VERSION
    frameSeq: number
    fragmentStartSu: number
    fragmentEndSu: number
    frameLengthSu: number
  }>

export type PtyOwnershipTransferOutputFragment = Readonly<{
  data: string
  ownershipTransfer: PtyOwnershipTransferOutputEnvelope
}>

export function parsePtyOwnershipTransferOutputEnvelope(
  value: unknown,
  data: string
): PtyOwnershipTransferOutputEnvelope | null {
  if (value === undefined) {
    return null
  }
  if (!isRecord(value)) {
    throw new Error('pty_ownership_transfer_output_envelope_invalid')
  }
  const identity = parseIdentity(value)
  if (value.version !== PTY_OWNERSHIP_TRANSFER_WIRE_VERSION) {
    throw new Error('pty_ownership_transfer_output_envelope_version_invalid')
  }
  const frameSeq = positiveSafeInteger(value.frameSeq, 'frameSeq')
  const fragmentStartSu = nonNegativeSafeInteger(value.fragmentStartSu, 'fragmentStartSu')
  const fragmentEndSu = nonNegativeSafeInteger(value.fragmentEndSu, 'fragmentEndSu')
  const frameLengthSu = positiveSafeInteger(value.frameLengthSu, 'frameLengthSu')
  if (
    fragmentStartSu >= fragmentEndSu ||
    fragmentEndSu > frameLengthSu ||
    data.length !== fragmentEndSu - fragmentStartSu
  ) {
    throw new Error('pty_ownership_transfer_output_envelope_range_invalid')
  }
  return Object.freeze({
    ...identity,
    version: PTY_OWNERSHIP_TRANSFER_WIRE_VERSION,
    frameSeq,
    fragmentStartSu,
    fragmentEndSu,
    frameLengthSu
  })
}

export function assertPtyOwnershipTransferOutputEnvelope(
  envelope: PtyOwnershipTransferOutputEnvelope,
  data: string
): void {
  parsePtyOwnershipTransferOutputEnvelope(envelope, data)
}

function parseIdentity(value: Record<string, unknown>): PtyOwnershipTransferWireIdentity {
  return Object.freeze({
    bridgeId: requiredString(value.bridgeId, 'bridgeId'),
    terminalId: requiredString(value.terminalId, 'terminalId'),
    incarnationId: requiredString(value.incarnationId, 'incarnationId'),
    ownerLease: requiredString(value.ownerLease, 'ownerLease'),
    sourceOwnerGeneration: positiveSafeInteger(
      value.sourceOwnerGeneration,
      'sourceOwnerGeneration'
    ),
    destinationRuntimeId: requiredString(value.destinationRuntimeId, 'destinationRuntimeId')
  })
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`pty_ownership_transfer_output_envelope_${name}_invalid`)
  }
  return value
}

function positiveSafeInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error(`pty_ownership_transfer_output_envelope_${name}_invalid`)
  }
  return value as number
}

function nonNegativeSafeInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`pty_ownership_transfer_output_envelope_${name}_invalid`)
  }
  return value as number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
