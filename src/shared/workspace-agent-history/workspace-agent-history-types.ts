/** Agent transcripts (Claude Code, Codex, OpenCode…) on this computer. */
export type WorkspaceAgentHistoryTranscriptTally = {
  /** Every transcript scanned on this computer. */
  total: number
  /** Those whose folder belongs to a deleted workspace. */
  matched: number
  bytes: number
  /** Matched but possibly still open, so kept. */
  inUse: number
  deleted: number
  /** Matched but not removable: unknown layout, a refused path or a removal error. */
  failed: number
}

/** Orca's own chats, from the chat database. */
export type WorkspaceAgentHistoryChatTally = {
  total: number
  matched: number
  inUse: number
  deleted: number
}

export type WorkspaceAgentHistoryTally = {
  transcripts: WorkspaceAgentHistoryTranscriptTally
  chats: WorkspaceAgentHistoryChatTally
}
