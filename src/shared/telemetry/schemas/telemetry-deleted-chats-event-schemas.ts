import { z } from 'zod'
import { lazyZodSchema } from '../../schema/lazy-zod-schema'

// Why: whether deleting chats with their workspace frees space without failures, and how much.
// Buckets and fixed enums only: never a path, chat, workspace or host id, or chat content.

export const DELETED_CHATS_COUNT_BUCKETS = [
  '0',
  '1_10',
  '11_100',
  '101_1000',
  '1001_10000',
  'gt_10000'
] as const

export const DELETED_CHATS_BYTES_BUCKETS = [
  'lt_10mb',
  '10mb_100mb',
  '100mb_1gb',
  '1gb_10gb',
  'gte_10gb'
] as const

export const DELETED_CHATS_DURATION_BUCKETS = [
  'lt_1s',
  '1s_10s',
  '10s_1m',
  '1m_10m',
  '10m_1h',
  'gte_1h'
] as const

const count = lazyZodSchema(() => z.enum(DELETED_CHATS_COUNT_BUCKETS))
const duration = lazyZodSchema(() => z.enum(DELETED_CHATS_DURATION_BUCKETS))

/** One cleanup run's sweep of chats whose workspace folder is gone. */
export const deletedChatsSweepSchema = lazyZodSchema(() =>
  z
    .object({
      trigger: z.enum(['startup', 'hourly', 'settings', 'run-now', 'cli']),
      orca_chats_on: z.boolean(),
      transcripts_on: z.boolean(),
      orca_chats_bucket: count,
      orca_failed_bucket: count,
      // Left for a later sweep while an older Orca's copy of the chat is still being converted.
      orca_skipped_bucket: count,
      transcripts_bucket: count,
      transcripts_failed_bucket: count,
      elapsed_ms_bucket: duration
    })
    .strict()
)

/** One background pass deleting the saved rows of deleted chats; bytes are the rows' own text. */
export const deletedChatsDiscardSchema = lazyZodSchema(() =>
  z
    .object({
      chats_bucket: count,
      bytes_bucket: z.enum(DELETED_CHATS_BYTES_BUCKETS),
      failed: z.boolean(),
      elapsed_ms_bucket: duration
    })
    .strict()
)
