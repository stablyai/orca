export type AgentSessionCompactionState = 'idle' | 'requested' | 'running' | 'completed' | 'failed'

export type AgentSessionContextSnapshot = {
  /** Provider-reported model for this exact live session, when available. */
  model?: string | null
  /** Provider-reported reasoning effort for this exact live session, when available. */
  effort?: string | null
  /** Provider-reported Fast mode for this exact live session, when available. */
  fastMode?: boolean | null
  usedTokens: number | null
  maxTokens: number | null
  remainingTokens: number | null
  usedPercent: number | null
  estimated?: boolean
  source: 'provider' | 'hook' | 'statusline' | 'unavailable'
  observedAt: number | null
  compaction: AgentSessionCompactionState
  compactionUpdatedAt: number | null
  error?: string
}

export const EMPTY_AGENT_SESSION_CONTEXT: AgentSessionContextSnapshot = {
  usedTokens: null,
  maxTokens: null,
  remainingTokens: null,
  usedPercent: null,
  source: 'unavailable',
  observedAt: null,
  compaction: 'idle',
  compactionUpdatedAt: null
}
