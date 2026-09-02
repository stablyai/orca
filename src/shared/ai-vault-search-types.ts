import type { AiVaultAgent, AiVaultSessionPreviewMessage } from './ai-vault-types'

export const AI_VAULT_SEARCH_QUERY_MAX_LENGTH = 512
export const AI_VAULT_SEARCH_LIMIT_MAX = 100
export const AI_VAULT_SEARCH_LIMIT_DEFAULT = 20

export type AiVaultSearchSort = 'relevance' | 'newest'

export type AiVaultSearchArgs = {
  query: string
  limit?: number
  agents?: readonly AiVaultAgent[]
  /** Restrict to sessions whose cwd is inside one of these paths. */
  scopePaths?: readonly string[]
  /** ISO timestamp; only sessions updated at or after it. */
  since?: string
  sort?: AiVaultSearchSort
  /** As-you-type tier: conversation-only index (no tool output), ~10x faster. */
  tier?: 'full' | 'conversation'
  /** Fold in transcript appends before searching (default true; the as-you-type tier passes false). */
  refresh?: boolean
}

export type AiVaultSearchEvidence = {
  role: AiVaultSessionPreviewMessage['role']
  timestamp: string | null
  /** FTS5 snippet with the matched terms wrapped in `[` `]`. */
  snippet: string
}

export type AiVaultSearchHit = {
  agent: AiVaultAgent
  sessionId: string
  filePath: string
  codexHome: string | null
  title: string
  cwd: string | null
  branch: string | null
  updatedAt: string | null
  messageCount: number
  resumeCommand: string
  score: number
  evidence: AiVaultSearchEvidence
}

/** How the query was executed; logged locally so the eval set can be rebuilt from real usage. */
export type AiVaultSearchRoute = 'phrase' | 'and' | 'or' | 'typo+phrase' | 'typo+and' | 'typo+or'

export type AiVaultSearchResult = {
  hits: AiVaultSearchHit[]
  route: AiVaultSearchRoute
  /** Query terms after typo repair, when any were changed. */
  repairedTerms?: string[]
  durationMs: number
  coverage: AiVaultSearchCoverage
}

export type AiVaultSearchProviderCoverage = {
  agent: AiVaultAgent
  sessionsIndexed: number
  messagesIndexed: number
}

export type AiVaultSearchCoverage = {
  sessionsIndexed: number
  messagesIndexed: number
  providers: AiVaultSearchProviderCoverage[]
  /** `running` means older sessions are still being added; results are partial until `complete`. */
  backfill: 'idle' | 'running' | 'complete'
  /** Files a list scan saw change that the index has not re-read yet. */
  filesPending: number
  lastIndexedAt: string | null
}
