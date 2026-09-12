/**
 * Durable metadata for a live PTY ownership transfer.
 *
 * Output bytes remain owned by the source delivery ledger until a later publication acknowledgement;
 * this journal only records the identity and monotonic cursors needed to fence a restart safely.
 */

import {
  MAX_PTY_OWNERSHIP_TRANSFER_JOURNALS,
  PTY_OWNERSHIP_TRANSFER_JOURNAL_VERSION,
  PTY_OWNERSHIP_TRANSFER_PUBLICATION_RECEIPT_VERSION,
  type PtyOwnershipTransferCommitReceipt,
  type PtyOwnershipTransferIdentity,
  type PtyOwnershipTransferJournal,
  type PtyOwnershipTransferJournalBase,
  type PtyOwnershipTransferPublicationReceipt
} from './pty-ownership-transfer-journal-contract'
import {
  boundedString,
  requireDate,
  requirePhase,
  requirePositiveInteger,
  requireRecord,
  requireSequence
} from './pty-ownership-transfer-value-validation'
import { publicationReceiptMatchesPtyOwnershipTransfer } from './pty-ownership-transfer-receipt-validation'
import { parsePtyOwnershipTransferSurfaceBinding } from './pty-ownership-transfer-surface-binding'
import { samePtyOwnershipTransferIdentity } from './pty-ownership-transfer-identity'

export {
  MAX_PTY_OWNERSHIP_TRANSFER_JOURNALS,
  PTY_OWNERSHIP_TRANSFER_JOURNAL_VERSION,
  PTY_OWNERSHIP_TRANSFER_PUBLICATION_RECEIPT_VERSION
} from './pty-ownership-transfer-journal-contract'
export type {
  PtyOwnershipTransferCommitReceipt,
  PtyOwnershipTransferDestinationJournal,
  PtyOwnershipTransferIdentity,
  PtyOwnershipTransferJournal,
  PtyOwnershipTransferPublicationReceipt,
  PtyOwnershipTransferSourceJournal
} from './pty-ownership-transfer-journal-contract'
export { publicationReceiptMatchesPtyOwnershipTransfer } from './pty-ownership-transfer-receipt-validation'

export function normalizePtyOwnershipTransferJournals(
  value: unknown
): PtyOwnershipTransferJournal[] {
  if (!Array.isArray(value)) {
    return []
  }
  const journals: PtyOwnershipTransferJournal[] = []
  const keys = new Set<string>()
  for (let index = value.length - 1; index >= 0; index--) {
    try {
      const journal = parsePtyOwnershipTransferJournal(value[index])
      const key = `${journal.bridgeId}:${journal.side}`
      if (keys.has(key)) {
        continue
      }
      keys.add(key)
      journals.push(journal)
      if (journals.length === MAX_PTY_OWNERSHIP_TRANSFER_JOURNALS) {
        break
      }
    } catch {
      // Invalid journals cannot authorize a source retirement or destination publication.
    }
  }
  // Keep durable transfer recovery runnable in the documented Node 18 rollback slot.
  return journals.reduceRight<PtyOwnershipTransferJournal[]>((reversed, journal) => {
    reversed.push(journal)
    return reversed
  }, [])
}

export function parsePtyOwnershipTransferJournal(value: unknown): PtyOwnershipTransferJournal {
  const record = requireRecord(value, 'pty_ownership_transfer_journal_invalid')
  if (record.version !== PTY_OWNERSHIP_TRANSFER_JOURNAL_VERSION) {
    throw new Error('pty_ownership_transfer_journal_version_unsupported')
  }
  const base = parseBase(record)
  if (record.side === 'source') {
    const phase = requirePhase(
      record.phase,
      ['prepared', 'commit-observed', 'publication-observed', 'retired', 'aborted'],
      'pty_ownership_transfer_source_phase_invalid'
    )
    const sourceOutputEndSeq = requireSequence(
      record.sourceOutputEndSeq,
      'pty_ownership_transfer_source_output_invalid'
    )
    const destinationOutputEndSeq = requireSequence(
      record.destinationOutputEndSeq,
      'pty_ownership_transfer_destination_output_invalid'
    )
    if (destinationOutputEndSeq > sourceOutputEndSeq) {
      throw new Error('pty_ownership_transfer_destination_output_ahead')
    }
    if (
      (phase === 'publication-observed' || phase === 'retired') &&
      destinationOutputEndSeq !== sourceOutputEndSeq
    ) {
      throw new Error('pty_ownership_transfer_source_output_not_caught_up')
    }
    const receipt = optionalReceipt(record.receipt, base.bridgeId)
    if (
      (phase === 'commit-observed' || phase === 'publication-observed' || phase === 'retired') !==
      Boolean(receipt)
    ) {
      throw new Error('pty_ownership_transfer_source_receipt_phase_mismatch')
    }
    if (receipt && receipt.acceptedSourceEndSeq !== destinationOutputEndSeq) {
      throw new Error('pty_ownership_transfer_source_receipt_cursor_mismatch')
    }
    if (phase === 'aborted' && receipt) {
      throw new Error('pty_ownership_transfer_aborted_receipt_invalid')
    }
    const publicationReceipt = optionalPublicationReceipt(record.publicationReceipt, base, receipt)
    if ((phase === 'publication-observed' || phase === 'retired') !== Boolean(publicationReceipt)) {
      throw new Error('pty_ownership_transfer_source_publication_phase_mismatch')
    }
    if (phase === 'aborted' && publicationReceipt) {
      throw new Error('pty_ownership_transfer_aborted_publication_invalid')
    }
    return {
      ...base,
      side: 'source',
      phase,
      sourceOutputEndSeq,
      destinationOutputEndSeq,
      ...(receipt ? { receipt } : {}),
      ...(publicationReceipt ? { publicationReceipt } : {})
    }
  }
  if (record.side === 'destination') {
    const phase = requirePhase(
      record.phase,
      ['prepared', 'committed', 'published', 'aborted'],
      'pty_ownership_transfer_destination_phase_invalid'
    )
    const acceptedSourceEndSeq = requireSequence(
      record.acceptedSourceEndSeq,
      'pty_ownership_transfer_destination_cursor_invalid'
    )
    const receipt = optionalReceipt(record.receipt, base.bridgeId)
    if ((phase === 'committed' || phase === 'published') !== Boolean(receipt)) {
      throw new Error('pty_ownership_transfer_destination_receipt_phase_mismatch')
    }
    if (receipt && receipt.acceptedSourceEndSeq !== acceptedSourceEndSeq) {
      throw new Error('pty_ownership_transfer_destination_receipt_cursor_mismatch')
    }
    const publicationReceipt = optionalPublicationReceipt(record.publicationReceipt, base, receipt)
    if ((phase === 'published') !== Boolean(publicationReceipt)) {
      throw new Error('pty_ownership_transfer_published_phase_mismatch')
    }
    if (phase === 'aborted' && (receipt || publicationReceipt)) {
      throw new Error('pty_ownership_transfer_aborted_state_invalid')
    }
    return {
      ...base,
      side: 'destination',
      phase,
      acceptedSourceEndSeq,
      ...(receipt ? { receipt } : {}),
      ...(publicationReceipt ? { publicationReceipt } : {})
    }
  }
  throw new Error('pty_ownership_transfer_journal_side_invalid')
}

export function assertPtyOwnershipTransferIdentity(
  journal: PtyOwnershipTransferJournal,
  identity: PtyOwnershipTransferIdentity
): void {
  if (!samePtyOwnershipTransferIdentity(journal, identity)) {
    throw new Error('pty_ownership_transfer_identity_conflict')
  }
}

export function receiptMatchesPtyOwnershipTransfer(
  receipt: PtyOwnershipTransferCommitReceipt,
  identity: PtyOwnershipTransferIdentity,
  acceptedSourceEndSeq: number
): boolean {
  return (
    receipt.bridgeId === identity.bridgeId &&
    receipt.acceptedSourceEndSeq === acceptedSourceEndSeq &&
    receipt.receiptId.length > 0 &&
    Number.isSafeInteger(receipt.acceptedSourceEndSeq) &&
    receipt.acceptedSourceEndSeq >= 0 &&
    Number.isFinite(Date.parse(receipt.committedAt))
  )
}

export function parsePtyOwnershipTransferPublicationReceipt(
  value: unknown,
  identity: PtyOwnershipTransferIdentity,
  commitReceipt: PtyOwnershipTransferCommitReceipt
): PtyOwnershipTransferPublicationReceipt {
  const receipt = optionalPublicationReceipt(value, identity, commitReceipt)
  if (!receipt) {
    throw new Error('pty_ownership_transfer_publication_receipt_missing')
  }
  return receipt
}

function parseBase(record: Record<string, unknown>): PtyOwnershipTransferJournalBase {
  return {
    version: PTY_OWNERSHIP_TRANSFER_JOURNAL_VERSION,
    bridgeId: boundedString(record.bridgeId, 'pty_ownership_transfer_bridge_id_invalid'),
    terminalId: boundedString(record.terminalId, 'pty_ownership_transfer_terminal_id_invalid'),
    incarnationId: boundedString(
      record.incarnationId,
      'pty_ownership_transfer_incarnation_id_invalid'
    ),
    ownerLease: boundedString(record.ownerLease, 'pty_ownership_transfer_owner_lease_invalid'),
    sourceOwnerGeneration: requirePositiveInteger(
      record.sourceOwnerGeneration,
      'pty_ownership_transfer_source_generation_invalid'
    ),
    destinationRuntimeId: boundedString(
      record.destinationRuntimeId,
      'pty_ownership_transfer_destination_runtime_invalid'
    ),
    startedAt: requireDate(record.startedAt, 'pty_ownership_transfer_started_at_invalid'),
    updatedAt: requireDate(record.updatedAt, 'pty_ownership_transfer_updated_at_invalid')
  }
}

function optionalReceipt(
  value: unknown,
  bridgeId: string
): PtyOwnershipTransferCommitReceipt | undefined {
  if (value === undefined) {
    return undefined
  }
  const record = requireRecord(value, 'pty_ownership_transfer_receipt_invalid')
  const receipt: PtyOwnershipTransferCommitReceipt = {
    receiptId: boundedString(record.receiptId, 'pty_ownership_transfer_receipt_id_invalid'),
    bridgeId: boundedString(record.bridgeId, 'pty_ownership_transfer_receipt_bridge_invalid'),
    acceptedSourceEndSeq: requireSequence(
      record.acceptedSourceEndSeq,
      'pty_ownership_transfer_receipt_cursor_invalid'
    ),
    committedAt: requireDate(record.committedAt, 'pty_ownership_transfer_receipt_time_invalid')
  }
  if (receipt.bridgeId !== bridgeId) {
    throw new Error('pty_ownership_transfer_receipt_identity_mismatch')
  }
  return receipt
}

function optionalPublicationReceipt(
  value: unknown,
  identity: PtyOwnershipTransferIdentity,
  commitReceipt: PtyOwnershipTransferCommitReceipt | undefined
): PtyOwnershipTransferPublicationReceipt | undefined {
  if (value === undefined) {
    return undefined
  }
  const record = requireRecord(value, 'pty_ownership_transfer_publication_receipt_invalid')
  const parsedCommitReceipt = optionalReceipt(record.commitReceipt, identity.bridgeId)
  if (!parsedCommitReceipt) {
    throw new Error('pty_ownership_transfer_publication_commit_receipt_missing')
  }
  const publicationReceipt: PtyOwnershipTransferPublicationReceipt = {
    version: requirePublicationReceiptVersion(record.version),
    publicationReceiptId: boundedString(
      record.publicationReceiptId,
      'pty_ownership_transfer_publication_receipt_id_invalid'
    ),
    bridgeId: boundedString(record.bridgeId, 'pty_ownership_transfer_publication_bridge_invalid'),
    destinationRuntimeId: boundedString(
      record.destinationRuntimeId,
      'pty_ownership_transfer_publication_destination_invalid'
    ),
    commitReceipt: parsedCommitReceipt,
    publishedAt: requireDate(record.publishedAt, 'pty_ownership_transfer_publication_time_invalid'),
    ...(record.surfaceBinding === undefined
      ? {}
      : { surfaceBinding: parsePtyOwnershipTransferSurfaceBinding(record.surfaceBinding) })
  }
  if (
    !commitReceipt ||
    !publicationReceiptMatchesPtyOwnershipTransfer(publicationReceipt, identity, commitReceipt)
  ) {
    throw new Error('pty_ownership_transfer_publication_receipt_mismatch')
  }
  return publicationReceipt
}

function requirePublicationReceiptVersion(
  value: unknown
): typeof PTY_OWNERSHIP_TRANSFER_PUBLICATION_RECEIPT_VERSION {
  if (value !== PTY_OWNERSHIP_TRANSFER_PUBLICATION_RECEIPT_VERSION) {
    throw new Error('pty_ownership_transfer_publication_version_unsupported')
  }
  return value
}
