import { z } from 'zod'

// Why: whether the old chat journal is actually deleted for users after an update, and if not,
// which check keeps it. Only the outcome, a fixed reason and a size bucket; never a path, chat id,
// column name or chat content.

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

export const LEGACY_JOURNAL_RETIREMENT_BYTES_BUCKETS = [
  'lt_100mb',
  '100mb_1gb',
  '1gb_10gb',
  '10gb_50gb',
  'gte_50gb'
] as const

/** Why the journal stays for the rest of this launch without being refused for good. */
export const LEGACY_JOURNAL_RETIREMENT_WAITING_STAGES = [
  // This version copied the chats, or is older: deletion waits for an update.
  'same_version',
  // An older Orca wrote the journal since; the next launch takes that in first.
  'not_reconciled',
  // The journal's storage can't be locked safely, so it is never deleted there.
  'unsupported_storage'
] as const

export const legacyJournalRetirementSchema = z.discriminatedUnion('outcome', [
  z
    .object({
      outcome: z.literal('retired'),
      bytes_bucket: z.enum(LEGACY_JOURNAL_RETIREMENT_BYTES_BUCKETS)
    })
    .strict(),
  z
    .object({
      outcome: z.literal('refused'),
      reason: z.enum(LEGACY_JOURNAL_RETIREMENT_REASONS)
    })
    .strict(),
  z
    .object({
      outcome: z.literal('waiting'),
      stage: z.enum(LEGACY_JOURNAL_RETIREMENT_WAITING_STAGES)
    })
    .strict()
])
