import type {
  PtyOwnershipTransferCommitReceipt,
  PtyOwnershipTransferPublicationReceipt
} from './pty-ownership-transfer-journal-contract'
import { PTY_OWNERSHIP_TRANSFER_PUBLICATION_RECEIPT_VERSION } from './pty-ownership-transfer-journal-contract'
import { parsePtyOwnershipTransferSurfaceBinding } from './pty-ownership-transfer-surface-binding'

export function parsePtyOwnershipTransferCommitReceipt(
  value: unknown
): PtyOwnershipTransferCommitReceipt {
  const record = requireRecord(value, 'pty_ownership_transfer_commit_receipt_invalid')
  return {
    receiptId: requireString(record.receiptId, 'pty_ownership_transfer_receipt_id_invalid'),
    bridgeId: requireString(record.bridgeId, 'pty_ownership_transfer_receipt_bridge_invalid'),
    acceptedSourceEndSeq: requireSequence(
      record.acceptedSourceEndSeq,
      'pty_ownership_transfer_receipt_cursor_invalid'
    ),
    committedAt: requireDate(record.committedAt, 'pty_ownership_transfer_receipt_time_invalid')
  }
}

export function parsePtyOwnershipTransferPublicationReceipt(
  value: unknown
): PtyOwnershipTransferPublicationReceipt {
  const record = requireRecord(value, 'pty_ownership_transfer_publication_receipt_invalid')
  if (record.version !== PTY_OWNERSHIP_TRANSFER_PUBLICATION_RECEIPT_VERSION) {
    throw new Error('pty_ownership_transfer_publication_version_invalid')
  }
  const commitReceipt = parsePtyOwnershipTransferCommitReceipt(record.commitReceipt)
  return {
    version: PTY_OWNERSHIP_TRANSFER_PUBLICATION_RECEIPT_VERSION,
    publicationReceiptId: requireString(
      record.publicationReceiptId,
      'pty_ownership_transfer_publication_receipt_id_invalid'
    ),
    bridgeId: requireString(record.bridgeId, 'pty_ownership_transfer_publication_bridge_invalid'),
    destinationRuntimeId: requireString(
      record.destinationRuntimeId,
      'pty_ownership_transfer_publication_destination_invalid'
    ),
    commitReceipt,
    publishedAt: requireDate(record.publishedAt, 'pty_ownership_transfer_publication_time_invalid'),
    ...(record.surfaceBinding === undefined
      ? {}
      : { surfaceBinding: parsePtyOwnershipTransferSurfaceBinding(record.surfaceBinding) })
  }
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

function requireSequence(value: unknown, code: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(code)
  }
  return Number(value)
}

function requireDate(value: unknown, code: string): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new Error(code)
  }
  return value
}
