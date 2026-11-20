import { z } from 'zod'

// Why: whether the old chat journal is deleted for users after an update, whether the chat store
// holds every chat first, and if not, which check keeps the file. Fixed enums and buckets only:
// never a path, chat or host id, receipt, SQL, column name, error text or chat content.

/** Every reason the journal's content proof can refuse with, kept for good until the journal changes. */
export const LEGACY_JOURNAL_RETIREMENT_REASONS = [
  'source-inventory',
  'source-recovery',
  'source-orphan',
  'source-queue',
  'source-queued-only-v1',
  'source-corrupt',
  'source-newer',
  'source-history',
  'source-failed',
  'source-oversize'
] as const

export const LEGACY_JOURNAL_RETIREMENT_OUTCOMES = [
  // The policy turned the cleanup off: no proof ran and nothing was deleted.
  'off',
  // Kept for now, for the reason in `defer`.
  'deferred',
  // A check refused the file, for the reason in `reason`; it stays until the file changes.
  'refused',
  // The proof finished: the chat store holds everything in the file. The policy kept it.
  'proof_complete',
  // The proof finished and deletion was allowed, but the file couldn't be removed yet.
  'delete_failed',
  'deleted'
] as const

export const LEGACY_JOURNAL_RETIREMENT_DEFERS = [
  'none',
  // This version copied the chats, or is older: deletion waits for an update.
  'same_version',
  // An older Orca wrote the file since; the next launch takes that in first.
  'not_reconciled',
  // The file's storage can't be locked safely, so it is never deleted there.
  'unsupported_storage'
] as const

/** Shapes builds left behind that the refusal saw; `none` when it saw neither. */
export const LEGACY_JOURNAL_RETIREMENT_ARTIFACTS = ['none', 'source_json', 'pause_table'] as const

const COUNT_BUCKETS = ['0', '1_10', '11_100', '101_1000', '1001_10000', 'gt_10000'] as const
export type LegacyJournalRetirementCountBucket = (typeof COUNT_BUCKETS)[number]

export const LEGACY_JOURNAL_RETIREMENT_BYTES_BUCKETS = [
  'unknown',
  'lt_100mb',
  '100mb_1gb',
  '1gb_10gb',
  '10gb_50gb',
  'gte_50gb'
] as const

export const LEGACY_JOURNAL_RETIREMENT_DURATION_BUCKETS = [
  'unknown',
  'lt_1s',
  '1s_10s',
  '10s_1m',
  '1m_10m',
  '10m_1h',
  'gte_1h'
] as const

const count = z.enum(COUNT_BUCKETS)
export { COUNT_BUCKETS as LEGACY_JOURNAL_RETIREMENT_COUNT_BUCKETS }

/** Counts are what this run's walk saw; a resumed walk counts only the pages it read. */
export const legacyJournalRetirementSchema = z
  .object({
    outcome: z.enum(LEGACY_JOURNAL_RETIREMENT_OUTCOMES),
    reason: z.enum([...LEGACY_JOURNAL_RETIREMENT_REASONS, 'none']),
    defer: z.enum(LEGACY_JOURNAL_RETIREMENT_DEFERS),
    artifact: z.enum(LEGACY_JOURNAL_RETIREMENT_ARTIFACTS),
    mode: z.enum(['off', 'report', 'enforce']),
    policy_revision: z.number().int().min(0).max(1_000_000),
    inventory_revision: z.number().int().min(0).max(1000),
    completeness: z.enum(['unknown', 'partial', 'complete']),
    resumed: z.boolean(),
    chats_bucket: count,
    converted_bucket: count,
    not_converted_bucket: count,
    originals_bucket: count,
    copies_bucket: count,
    source_bytes_bucket: z.enum(LEGACY_JOURNAL_RETIREMENT_BYTES_BUCKETS),
    active_ms_bucket: z.enum(LEGACY_JOURNAL_RETIREMENT_DURATION_BUCKETS)
  })
  .strict()
