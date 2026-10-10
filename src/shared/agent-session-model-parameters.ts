export type AgentSessionOptionChoice = {
  value: string
  label: string
  description?: string
}

/** Model parameters a listing offers apart from effort (Cursor's context size and thinking). */
export type AgentSessionModelParameterOptions = {
  /** Context-window sizes the model offers, when the listing names more than one. */
  contextWindows?: AgentSessionOptionChoice[]
  defaultContextWindow?: string
  /** Thinking on/off (or levels), when the listing offers them separately from effort. */
  thinkingLevels?: AgentSessionOptionChoice[]
  defaultThinking?: string
}

/** Cursor's current next-turn picks for those parameters. Absent on Claude and Codex. */
export type AgentSessionCurrentModelParameters = {
  context?: string
  thinking?: string
  /** Cursor structured chat: agent or plan. */
  conversationMode?: 'agent' | 'plan'
}
