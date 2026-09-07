export const AI_VAULT_SESSION_LIMITS = [250, 500, 1000, 'unlimited'] as const

export type AiVaultSessionLimit = (typeof AI_VAULT_SESSION_LIMITS)[number]

export const DEFAULT_AI_VAULT_SESSION_LIMIT: AiVaultSessionLimit = 250

export function normalizeAiVaultSessionLimit(value: unknown): AiVaultSessionLimit {
  return AI_VAULT_SESSION_LIMITS.includes(value as AiVaultSessionLimit)
    ? (value as AiVaultSessionLimit)
    : DEFAULT_AI_VAULT_SESSION_LIMIT
}
