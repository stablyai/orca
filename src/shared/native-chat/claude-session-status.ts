/** What a paired client shows about a Claude chat that runs in a terminal. */
export type ClaudeSessionStatus = {
  model: string | null
  effort: string | null
  /** Null right after a compaction, until the next reply measures the context again. */
  usedTokens: number | null
  /** Null until Claude's statusline has reported this session's window. */
  windowTokens: number | null
  compactions: number
}

/** The part of the status that the session's transcript file can answer. */
export type ClaudeSessionStatusFacts = Omit<ClaudeSessionStatus, 'windowTokens'>
