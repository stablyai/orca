import type { PtyOwnershipTransferSurfaceBinding } from './pty-ownership-transfer-surface-binding'

export const PTY_OWNERSHIP_TRANSFER_JOURNAL_VERSION = 1 as const
export const PTY_OWNERSHIP_TRANSFER_PUBLICATION_RECEIPT_VERSION = 1 as const
export const MAX_PTY_OWNERSHIP_TRANSFER_JOURNALS = 64

export type PtyOwnershipTransferJournalBase = {
  version: typeof PTY_OWNERSHIP_TRANSFER_JOURNAL_VERSION
  bridgeId: string
  terminalId: string
  incarnationId: string
  ownerLease: string
  sourceOwnerGeneration: number
  destinationRuntimeId: string
  startedAt: string
  updatedAt: string
}

export type PtyOwnershipTransferCommitReceipt = {
  receiptId: string
  bridgeId: string
  acceptedSourceEndSeq: number
  committedAt: string
}

export type PtyOwnershipTransferPublicationReceipt = {
  version: typeof PTY_OWNERSHIP_TRANSFER_PUBLICATION_RECEIPT_VERSION
  publicationReceiptId: string
  bridgeId: string
  destinationRuntimeId: string
  commitReceipt: PtyOwnershipTransferCommitReceipt
  publishedAt: string
  /** Additive proof of the exact runtime-model surface. Older peers ignore it. */
  surfaceBinding?: PtyOwnershipTransferSurfaceBinding
}

export type PtyOwnershipTransferSourceJournal = PtyOwnershipTransferJournalBase & {
  side: 'source'
  phase: 'prepared' | 'commit-observed' | 'publication-observed' | 'retired' | 'aborted'
  sourceOutputEndSeq: number
  destinationOutputEndSeq: number
  receipt?: PtyOwnershipTransferCommitReceipt
  publicationReceipt?: PtyOwnershipTransferPublicationReceipt
}

export type PtyOwnershipTransferDestinationJournal = PtyOwnershipTransferJournalBase & {
  side: 'destination'
  phase: 'prepared' | 'committed' | 'published' | 'aborted'
  acceptedSourceEndSeq: number
  receipt?: PtyOwnershipTransferCommitReceipt
  publicationReceipt?: PtyOwnershipTransferPublicationReceipt
}

export type PtyOwnershipTransferJournal =
  | PtyOwnershipTransferSourceJournal
  | PtyOwnershipTransferDestinationJournal

export type PtyOwnershipTransferIdentity = Pick<
  PtyOwnershipTransferJournalBase,
  | 'bridgeId'
  | 'terminalId'
  | 'incarnationId'
  | 'ownerLease'
  | 'sourceOwnerGeneration'
  | 'destinationRuntimeId'
>
