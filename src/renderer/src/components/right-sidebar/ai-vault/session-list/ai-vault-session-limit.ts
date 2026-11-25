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
