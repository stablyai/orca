import type { AiVaultScope } from '../../../../shared/ai-vault-types'

/** Presets the History depth menu offers; Show more steps past them 250 at a time. */
export const AI_VAULT_SESSION_LIMITS = [250, 500, 1000, 'unlimited'] as const
export const AI_VAULT_SESSION_LIMIT_STEP = 250

export type AiVaultSessionLimit = number | 'unlimited'

export const DEFAULT_AI_VAULT_SESSION_LIMIT: AiVaultSessionLimit = 250

export function normalizeAiVaultSessionLimit(value: unknown): AiVaultSessionLimit {
  if (value === 'unlimited') {
    return value
  }
  return typeof value === 'number' && value > 0 && value % AI_VAULT_SESSION_LIMIT_STEP === 0
    ? value
    : DEFAULT_AI_VAULT_SESSION_LIMIT
}

/** The scan returned as many rows as it was allowed, so older sessions likely remain unread. */
export function aiVaultSessionsFillLimit(
  loaded: number,
  loadedSessionLimit: AiVaultSessionLimit | null
): boolean {
  return (
    loaded > 0 &&
    loadedSessionLimit !== null &&
    loadedSessionLimit !== 'unlimited' &&
    loaded >= loadedSessionLimit
  )
}

/**
 * Whether a deeper scan could still add rows to the tab the user is on.
 *
 * Two independent facts: the scan stopped at its depth at all, and — off the All
 * tab — whether the scanner vouched for this scope. `scopeFullyScanned` is only
 * true when every agent on the host buckets its transcripts by cwd, so the
 * scoped pass read them all; for any other agent a scoped view is a filter over
 * the capped list and a deeper scan genuinely adds in-scope rows.
 */
export function aiVaultViewMayHoldMoreSessions(args: {
  scope: AiVaultScope
  loaded: number
  loadedSessionLimit: AiVaultSessionLimit | null
  scopeFullyScanned: boolean
}): boolean {
  if (!aiVaultSessionsFillLimit(args.loaded, args.loadedSessionLimit)) {
    return false
  }
  return args.scope === 'all' || !args.scopeFullyScanned
}
