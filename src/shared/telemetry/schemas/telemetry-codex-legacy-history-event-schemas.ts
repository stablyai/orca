import { z } from 'zod'

/** Account histories are only read, whatever the outcome; `failed` retries on the next launch. */
export const CODEX_LEGACY_HISTORY_IMPORT_OUTCOMES = [
  'imported',
  'skipped_existing',
  'nothing_to_import',
  'skipped_no_hard_links',
  'failed'
] as const

/** Sent by each launch that tries the one-time import of legacy per-account prompt history. */
export const codexLegacyHistoryImportSchema = z
  .object({
    outcome: z.enum(CODEX_LEGACY_HISTORY_IMPORT_OUTCOMES),
    platform: z.enum(['darwin', 'linux', 'win32'])
  })
  .strict()
