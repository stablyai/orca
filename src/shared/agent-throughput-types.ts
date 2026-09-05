/**
 * Generation throughput of one pane's agent, measured per completed model call
 * from the agent's own session record (Claude/Codex transcripts, Gemini chat
 * files, OpenCode's database). No agent exposes intra-message counts, so a
 * sample only changes when a call completes.
 */
export type AgentThroughputSample = {
  paneKey: string
  /** Hook source the record was read for (claude, codex, gemini, opencode, ...). */
  agentType: string
  /** Provider-owned assistant message id the sample was measured on. */
  messageId: string
  model: string | null
  outputTokens: number
  /** Wall-clock ms from the transcript record preceding the message to its last row. */
  generationMs: number
  tokensPerSecond: number
  /** Epoch ms of the message's last transcript row. */
  completedAt: number
  /** Output tokens, generation ms, and message count accumulated since the turn's prompt. */
  turnOutputTokens: number
  turnGenerationMs: number
  turnMessageCount: number
  /** Epoch ms when the hook server observed the sample; orders pushes against snapshots. */
  observedAt: number
  /** True when the agent reports no token counts and `outputTokens` was estimated from text length. */
  estimated?: boolean
}

export type AgentThroughputClearIpcPayload = { paneKey: string }

/** One completed model call as read from a provider's on-disk session record. */
export type AgentMessageThroughput = {
  /** Provider-owned id when the record has one, else a synthetic key unique per call. */
  messageId: string
  model: string | null
  outputTokens: number
  generationMs: number
  completedAt: number
  /** Set by readers that estimate tokens from text length because the agent records none. */
  estimated?: true
}

/** Hook sources Orca can report for: per-message token counts on disk, or (Grok) a text-length estimate. */
export const AGENT_THROUGHPUT_MEASURED_AGENTS = [
  'claude',
  'codex',
  'gemini',
  'opencode',
  'mimo-code',
  'grok'
] as const

export function isAgentThroughputMeasured(agentType: string | undefined | null): boolean {
  return (
    typeof agentType === 'string' &&
    (AGENT_THROUGHPUT_MEASURED_AGENTS as readonly string[]).includes(agentType)
  )
}

export function computeTokensPerSecond(outputTokens: number, generationMs: number): number {
  if (!(outputTokens > 0) || !(generationMs > 0)) {
    return 0
  }
  return (outputTokens * 1000) / generationMs
}
