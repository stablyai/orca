import {
  parsePtyOwnershipTransferWireIdentity,
  type PtyOwnershipTransferWireIdentity
} from './pty-ownership-transfer-wire'
import { samePtyOwnershipTransferIdentity } from './pty-ownership-transfer-identity'
import { parsePtyOwnershipTransferDestinationInspectionRequest } from './pty-ownership-transfer-destination-claim'

export const PTY_OWNERSHIP_CAPTURE_IMPORT_ACK_METHOD = 'pty.ownershipTransfer.ackInitialModel'

export function parsePtyOwnershipCaptureImportAcknowledgementResult(value: unknown) {
  const identity = parsePtyOwnershipTransferWireIdentity(value)
  const record = value as Record<string, unknown>
  if (record.version !== 1) {
    throw new Error('pty_ownership_capture_import_ack_result_invalid')
  }
  return Object.freeze({
    ...identity,
    version: 1 as const,
    receipt: parsePtyOwnershipCaptureImportReceipt(record.receipt, identity)
  })
}

export function parsePtyOwnershipCaptureImportAcknowledgement(value: unknown) {
  const proof = parsePtyOwnershipTransferDestinationInspectionRequest(value)
  return Object.freeze({
    ...proof,
    receipt: parsePtyOwnershipCaptureImportReceipt(
      (value as Record<string, unknown>).receipt,
      proof
    )
  })
}

export type PtyOwnershipCaptureImportReceipt = ReturnType<
  typeof parsePtyOwnershipCaptureImportReceipt
>

/** The destination issues this only after rereading its durable initial model. */
export function parsePtyOwnershipCaptureImportReceipt(
  value: unknown,
  expected: PtyOwnershipTransferWireIdentity
) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('pty_ownership_capture_import_receipt_invalid')
  }
  const record = value as Record<string, unknown>
  const identity = parsePtyOwnershipTransferWireIdentity(record.identity)
  if (
    record.version !== 1 ||
    !samePtyOwnershipTransferIdentity(identity, expected) ||
    !Number.isSafeInteger(record.throughSeq) ||
    Number(record.throughSeq) < 0 ||
    typeof record.modelSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(record.modelSha256)
  ) {
    throw new Error('pty_ownership_capture_import_receipt_invalid')
  }
  return Object.freeze({
    version: 1 as const,
    identity: Object.freeze(identity),
    throughSeq: Number(record.throughSeq),
    modelSha256: record.modelSha256
  })
}
