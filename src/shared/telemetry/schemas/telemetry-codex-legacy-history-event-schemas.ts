import { z } from 'zod'

/** Orca keeps every legacy history aside in its metadata whatever the outcome; `failed` retries. */
export const CODEX_LEGACY_HISTORY_IMPORT_OUTCOMES = [
  'imported',
  'skipped_existing',
  'nothing_to_import',
  'failed'
] as const

/** Sent by each launch that tries the one-time import of legacy per-account prompt history. */
export const codexLegacyHistoryImportSchema = z
  .object({
    outcome: z.enum(CODEX_LEGACY_HISTORY_IMPORT_OUTCOMES),
    platform: z.enum(['darwin', 'linux', 'win32'])
  })
  .strict()
