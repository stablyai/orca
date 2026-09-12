import {
  PTY_OWNERSHIP_TRANSFER_PUBLICATION_RECEIPT_VERSION,
  type PtyOwnershipTransferCommitReceipt,
  type PtyOwnershipTransferIdentity,
  type PtyOwnershipTransferPublicationReceipt
} from './pty-ownership-transfer-journal-contract'
import { samePtyOwnershipTransferSurfaceBinding } from './pty-ownership-transfer-surface-binding'

export function publicationReceiptMatchesPtyOwnershipTransfer(
  publicationReceipt: PtyOwnershipTransferPublicationReceipt,
  identity: PtyOwnershipTransferIdentity,
  commitReceipt: PtyOwnershipTransferCommitReceipt
): boolean {
  return (
    publicationReceipt.version === PTY_OWNERSHIP_TRANSFER_PUBLICATION_RECEIPT_VERSION &&
    publicationReceipt.publicationReceiptId.length > 0 &&
    publicationReceipt.bridgeId === identity.bridgeId &&
    publicationReceipt.destinationRuntimeId === identity.destinationRuntimeId &&
    samePtyOwnershipTransferCommitReceipt(publicationReceipt.commitReceipt, commitReceipt) &&
    Number.isFinite(Date.parse(publicationReceipt.publishedAt))
  )
}

export function samePtyOwnershipTransferCommitReceipt(
  left: PtyOwnershipTransferCommitReceipt,
  right: PtyOwnershipTransferCommitReceipt
): boolean {
  return (
    left.receiptId === right.receiptId &&
    left.bridgeId === right.bridgeId &&
    left.acceptedSourceEndSeq === right.acceptedSourceEndSeq &&
    left.committedAt === right.committedAt
  )
}

export function samePtyOwnershipTransferPublicationReceipt(
  left: PtyOwnershipTransferPublicationReceipt,
  right: PtyOwnershipTransferPublicationReceipt
): boolean {
  return (
    left.version === right.version &&
    left.publicationReceiptId === right.publicationReceiptId &&
    left.bridgeId === right.bridgeId &&
    left.destinationRuntimeId === right.destinationRuntimeId &&
    left.publishedAt === right.publishedAt &&
    samePtyOwnershipTransferCommitReceipt(left.commitReceipt, right.commitReceipt) &&
    samePtyOwnershipTransferSurfaceBinding(left.surfaceBinding, right.surfaceBinding)
  )
}
