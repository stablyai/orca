import { z } from 'zod'

// Why counts only, bucketed: these rows decide whether deleting left-behind Codex history widens.
// A path, account or thread id would identify a machine, so none may appear.

export const CODEX_HISTORY_CLEANUP_COUNT_BUCKETS = [
  '0',
  '1',
  '2_10',
  '11_100',
  '101_500',
  'gt_500'
] as const

export const CODEX_HISTORY_CLEANUP_BYTES_BUCKETS = [
  '0',
  'lt_1mb',
  '1mb_100mb',
  '100mb_1gb',
  '1gb_10gb',
  'gte_10gb'
] as const

/** Why a candidate wasn't deleted (or, in report mode, wouldn't have been). */
export const CODEX_HISTORY_CLEANUP_SKIP_REASONS = [
  'changed',
  'hard_linked',
  'open',
  'open_unknown',
  'rehash_mismatch',
  'unshared',
  'not_proven_shared',
  'unlink_failed',
  'transient_capped'
] as const
export type CodexHistoryCleanupSkipReason = (typeof CODEX_HISTORY_CLEANUP_SKIP_REASONS)[number]

const count = z.enum(CODEX_HISTORY_CLEANUP_COUNT_BUCKETS)
const skippedFields = Object.fromEntries(
  CODEX_HISTORY_CLEANUP_SKIP_REASONS.map((reason) => [`skipped_${reason}_bucket`, count])
) as Record<`skipped_${CodexHistoryCleanupSkipReason}_bucket`, typeof count>

/** Sent once per install, kind, policy revision and mode, after the first sweep that finished. */
export const codexHistoryCleanupSweepSchema = z
  .object({
    kind: z.enum(['rollouts', 'databases']),
    mode: z.enum(['report', 'enforce']),
    revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    platform: z.enum(['darwin', 'win32']),
    candidates_bucket: count,
    eligible_bucket: count,
    // In report mode: what enforce would have deleted.
    deleted_bucket: count,
    bytes_bucket: z.enum(CODEX_HISTORY_CLEANUP_BYTES_BUCKETS),
    ...skippedFields,
    budget_hit: z.boolean()
  })
  .strict()
