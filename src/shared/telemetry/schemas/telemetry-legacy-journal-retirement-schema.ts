import { z } from 'zod'
import { isValidAppVersion } from '../../app-lifecycle/identity/app-version'

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
  // No old file, and nothing saved says this store deleted one.
  'absent',
  // Kept for now, for the reason in `defer`.
  'deferred',
  // A check refused the file, for the reason in `reason`; it stays until the file changes.
  'refused',
  // The proof finished: the chat store holds everything in the file. This build keeps it.
  'proof_complete',
  // The proof finished and this build deletes, but the file couldn't be removed yet.
  'delete_failed',
  // Deleted on this launch.
  'deleted',
  // Gone, and this store saved that it was deleting it on an earlier launch.
  'deleted_before',
  // The proof stopped for the reason in `error` and is tried again later.
  'proving'
] as const

export const LEGACY_JOURNAL_RETIREMENT_ERRORS = [
  'none',
  // Paused for activity, or stopped by quitting.
  'interrupted',
  // A chat's conversion failed.
  'conversion',
  // The store or the file could not be read or written.
  'storage',
  // A check that waits on something to settle, such as a chat an older Orca wrote.
  'pending',
  'other'
] as const

export const LEGACY_JOURNAL_RETIREMENT_DEFERS = [
  'none',
  // This version copied the chats, or is older: deletion waits for an update.
  'same_version',
  // An older Orca wrote the file since; the next launch takes that in first.
  'not_reconciled',
  // The file's storage can't be locked safely, so it is never deleted there.
  'unsupported_storage',
  'leftover_files'
] as const

/**
 * Shapes builds left behind that an inventory refusal saw (`none`: neither); `unknown` for any other
 * outcome, and for refusals saved before this was recorded.
 */
export const LEGACY_JOURNAL_RETIREMENT_ARTIFACTS = [
  'unknown',
  'none',
  'source_json',
  'pause_table',
  'both'
] as const

// `unknown`: not measured (no walk this launch, or older progress); never reported as 0.
const COUNT_BUCKETS = [
  'unknown',
  '0',
  '1_10',
  '11_100',
  '101_1000',
  '1001_10000',
  'gt_10000'
] as const
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
    error: z.enum(LEGACY_JOURNAL_RETIREMENT_ERRORS),
    // Whether this build deletes a proven file; fixed per build.
    deletes: z.boolean(),
    inventory_revision: z.number().int().min(0).max(1000),
    completeness: z.enum(['unknown', 'partial', 'complete']),
    resumed: z.boolean(),
    chats_bucket: count,
    // Converted before the proof reached them, and converted by the proof (store growth).
    already_converted_bucket: count,
    newly_converted_bucket: count,
    // Deleted here (the original's version kept), and drafts (a record, no history).
    deleted_here_bucket: count,
    drafts_bucket: count,
    originals_bucket: count,
    copies_bucket: count,
    source_bytes_bucket: z.enum(LEGACY_JOURNAL_RETIREMENT_BYTES_BUCKETS),
    // The check's own reading and comparing, without conversions or pauses for activity.
    active_ms_bucket: z.enum(LEGACY_JOURNAL_RETIREMENT_DURATION_BUCKETS),
    // From this launch's first attempt to this outcome, pauses for activity included.
    elapsed_ms_bucket: z.enum(LEGACY_JOURNAL_RETIREMENT_DURATION_BUCKETS)
  })
  .strict()

export const legacyJournalRetirementHostVersionSchema = z
  .string()
  .max(64)
  .refine((version) => version === version.trim() && isValidAppVersion(version))

export const legacyJournalRetirementTelemetrySchema = z.union([
  legacyJournalRetirementSchema.extend({ runtime: z.literal('local').optional() }),
  legacyJournalRetirementSchema.extend({
    runtime: z.literal('remote'),
    host_app_version: legacyJournalRetirementHostVersionSchema
  })
])
