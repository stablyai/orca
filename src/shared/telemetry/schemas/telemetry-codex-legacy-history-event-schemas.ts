import { z } from 'zod'

/** `skipped_existing` and `failed` keep each legacy history aside in Orca's metadata. */
export const CODEX_LEGACY_HISTORY_IMPORT_OUTCOMES = [
  'imported',
  'skipped_existing',
  'failed'
] as const

/** Sent once per install, by the one-time migration of legacy per-account prompt history. */
export const codexLegacyHistoryImportSchema = z
  .object({
    outcome: z.enum(CODEX_LEGACY_HISTORY_IMPORT_OUTCOMES),
    platform: z.enum(['darwin', 'linux', 'win32'])
  })
  .strict()
