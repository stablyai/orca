/**
 * Consent + retention policy for the agent-session transcript index.
 *
 * Off until the user turns it on: building the index reads every transcript on
 * the machine, so nothing may open the database, register the capture sink, or
 * backfill before that choice is made.
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

/** Offered in Settings; any other positive integer is still honoured if persisted. */
export const AI_VAULT_SEARCH_HISTORY_DAY_OPTIONS: readonly (number | null)[] = [null, 90, 30]

const HISTORY_DAYS_MAX = 3_650

export function normalizeAiVaultSearchHistoryDays(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return null
  }
  const days = Math.floor(value)
  // Why: a fractional day floors to 0, which the UI shows as "all history"
  // while the cutoff would be "now"; make the two agree.
  return days <= 0 ? null : Math.min(HISTORY_DAYS_MAX, days)
}

export function resolveAiVaultSearchSettings(
  settings: { aiVaultSearch?: Partial<AiVaultSearchSettings> | null } | null | undefined
): AiVaultSearchSettings {
  const raw = settings?.aiVaultSearch
  return {
    enabled: raw?.enabled === true,
    historyDays: normalizeAiVaultSearchHistoryDays(raw?.historyDays)
  }
}

/** What Settings shows about the local index: the policy plus its disk footprint. */
export type AiVaultSearchIndexStatus = AiVaultSearchSettings & {
  /** Database + WAL sidecars in bytes; null when no index file exists. */
  indexSizeBytes: number | null
}

/** Files older than the bound are skipped; already-indexed rows stay searchable until a clear. */
export function aiVaultSearchHistoryCutoffMs(
  historyDays: number | null,
  now = Date.now()
): number | null {
  return historyDays === null ? null : now - historyDays * 86_400_000
}
