import { z } from 'zod'

/**
 * Consent and retention for the agent-session transcript index.
 *
 * Off until the user turns it on: building the index reads every transcript on
 * the machine, so nothing constructs an indexer, opens the database or reads a
 * transcript for it before that choice is recorded.
 *
 * There is no `paused`. The indexer is immutable after construction, so every
 * change here is close-and-construct (see session-search-instance.ts).
 */
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
  // A fractional day floors to 0, which reads as "all history" on one side and
  // "now" on the other; make the two agree.
  const days = Math.floor(value)
  return days <= 0 ? null : Math.min(HISTORY_DAYS_MAX, days)
}

/**
 * The persisted shape, from whatever a settings write or an old profile left behind.
 *
 * The input is `unknown` on purpose: this is the sanitizer, and what it reads is a
 * JSON profile that may predate either field or hold a value no version wrote.
 */
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

/**
 * The policy a settings write moves to, or null when nothing about it changed.
 *
 * Every host that owns an index closes and reconstructs on apply, so an unchanged
 * value has to be filtered here rather than at the indexer.
 */
export function changedAiVaultSearchSettings(
  before: { aiVaultSearch?: unknown } | null | undefined,
  after: { aiVaultSearch?: unknown } | null | undefined
): AiVaultSearchSettings | null {
  const next = resolveAiVaultSearchSettings(after)
  return sameAiVaultSearchSettings(resolveAiVaultSearchSettings(before), next) ? null : next
}
