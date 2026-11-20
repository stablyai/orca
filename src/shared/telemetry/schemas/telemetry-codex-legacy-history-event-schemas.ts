import { z } from 'zod'

/** `codex_live`, `busy`, `no_helper` and `changed` are skips the next launch retries. */
export const CODEX_LEGACY_HISTORY_IMPORT_OUTCOMES = [
  'imported',
  'codex_live',
  'busy',
  'no_helper',
  'changed',
  'failed'
] as const

/** One row per launch that still had the one-time legacy prompt-history import pending. */
export const codexLegacyHistoryImportSchema = z
  .object({
    outcome: z.enum(CODEX_LEGACY_HISTORY_IMPORT_OUTCOMES),
    platform: z.enum(['darwin', 'linux', 'win32'])
  })
  .strict()
