export type AgentSessionNamingError = {
  message: string
  failedAt: number
  /** Names Orca-authored copy; `message` stays English for older clients. */
  messageCode?: string
}

export type AgentSessionConversationName = {
  sessionId: string
  conversationName: string | null
  namingError?: AgentSessionNamingError
}

/** Retain projections after child eviction; idle remains idle. Tabs decide list membership, never this feed. */
