import type { AiVaultSessionMessageHit } from './ai-vault-session-message-hit'

export type {
  AiVaultSessionMessageHit,
  AiVaultSessionMessageJump
} from './ai-vault-session-message-hit'

export const AI_VAULT_SEARCH_SCOPES = [
  'full',
  'title',
  'summary',
  'fullWithoutTools',
  'user',
  'assistant',
  'errors'
] as const

export type AiVaultSearchScope = (typeof AI_VAULT_SEARCH_SCOPES)[number]

export const DEFAULT_AI_VAULT_SEARCH_SCOPE: AiVaultSearchScope = 'full'

export const AI_VAULT_RG_SEARCH_SCOPES = [
  'full',
  'fullWithoutTools',
  'user',
  'assistant',
  'errors'
] as const satisfies readonly AiVaultSearchScope[]

export type AiVaultRgSearchScope = (typeof AI_VAULT_RG_SEARCH_SCOPES)[number]

export const AI_VAULT_SEARCH_SCOPE_STORAGE_KEY = 'orca:ai-vault-search-scope'

export function isAiVaultSearchScope(value: unknown): value is AiVaultSearchScope {
  return typeof value === 'string' && (AI_VAULT_SEARCH_SCOPES as readonly string[]).includes(value)
}

export function isAiVaultRgSearchScope(value: unknown): value is AiVaultRgSearchScope {
  return (
    typeof value === 'string' && (AI_VAULT_RG_SEARCH_SCOPES as readonly string[]).includes(value)
  )
}

export function normalizeAiVaultSearchScope(value: unknown): AiVaultSearchScope {
  return isAiVaultSearchScope(value) ? value : DEFAULT_AI_VAULT_SEARCH_SCOPE
}

export type AiVaultSearchSessionsArgs = {
  query: string
  searchScope: AiVaultRgSearchScope
  sessionIds: readonly string[]
}

export type AiVaultSearchSessionsResult = {
  matchedIds: string[]
  usedRg: boolean
  usedFts: boolean
  truncated: boolean
  degraded: boolean
  hits: AiVaultSessionMessageHit[]
}

export function emptyAiVaultSearchSessionsResult(): AiVaultSearchSessionsResult {
  return {
    matchedIds: [],
    usedRg: false,
    usedFts: false,
    truncated: false,
    degraded: false,
    hits: []
  }
}
