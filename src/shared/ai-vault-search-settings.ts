import { z } from 'zod'

/** Recorded opt-in precedes indexer construction, database open or transcript reads. Immutable indexers have no paused state; policy changes close/reconstruct them (session-search-instance.ts). */
export type AiVaultSearchSettings = {
  enabled: boolean
  /** null = all history; otherwise only transcripts modified within this many days. */
  historyDays: number | null
}

export const DEFAULT_AI_VAULT_SEARCH_SETTINGS: AiVaultSearchSettings = {
  enabled: false,
  historyDays: null
}

const HISTORY_DAYS_MAX = 3_650

export const AiVaultSearchSettingsSchema: z.ZodType<AiVaultSearchSettings> = z.object({
  enabled: z.boolean(),
  historyDays: z.number().int().positive().max(HISTORY_DAYS_MAX).nullable()
})

export function normalizeAiVaultSearchHistoryDays(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return null
  }
  // Normalize fractional days consistently: floor-to-zero cannot mean all history on one side and now on another.
  const days = Math.floor(value)
  return days <= 0 ? null : Math.min(HISTORY_DAYS_MAX, days)
}

/** Sanitize unknown stored profiles, including missing fields and values no supported version wrote. */
export function resolveAiVaultSearchSettings(
  settings: { aiVaultSearch?: unknown } | null | undefined
): AiVaultSearchSettings {
  const raw = settings?.aiVaultSearch
  if (typeof raw !== 'object' || raw === null) {
    return { ...DEFAULT_AI_VAULT_SEARCH_SETTINGS }
  }
  return {
    enabled: 'enabled' in raw && raw.enabled === true,
    historyDays: normalizeAiVaultSearchHistoryDays('historyDays' in raw ? raw.historyDays : null)
  }
}

export function sameAiVaultSearchSettings(
  a: AiVaultSearchSettings,
  b: AiVaultSearchSettings
): boolean {
  return a.enabled === b.enabled && a.historyDays === b.historyDays
}

/** Filter unchanged policies here; every owning host otherwise closes/reconstructs its index on apply. */
export function changedAiVaultSearchSettings(
  before: { aiVaultSearch?: unknown } | null | undefined,
  after: { aiVaultSearch?: unknown } | null | undefined
): AiVaultSearchSettings | null {
  const next = resolveAiVaultSearchSettings(after)
  return sameAiVaultSearchSettings(resolveAiVaultSearchSettings(before), next) ? null : next
}
