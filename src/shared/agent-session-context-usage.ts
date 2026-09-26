// What the provider has said about a session's context window, as facts on
// turn rows. Writes land only on the open or newest turn and each replaces its
// namesake, so a reader takes the part from the newest row that carries it.

/** The API's accounting on one assistant response. */
export type AgentSessionTokenUsage = {
  inputTokens: number
  cacheCreationInputTokens: number
  cacheReadInputTokens: number
  outputTokens: number
}

/** Everything the model read on that request, which is what fills the window. */
export function contextTokensFromUsage(usage: AgentSessionTokenUsage): number {
  return usage.inputTokens + usage.cacheCreationInputTokens + usage.cacheReadInputTokens
}

/** Longest model id a fact records; a longer one is not a model id. */
export const MAX_CONTEXT_MODEL_ID_CHARS = 256
export const MAX_CONTEXT_CATEGORIES = 64
export const MAX_CONTEXT_CATEGORY_NAME_CHARS = 80

/** One row of the provider's breakdown, as it names and counts it. */
export type AgentSessionContextUsageCategory = {
  /** Display name as the provider renders it, e.g. `Messages`. */
  name: string
  tokens: number
  /** Listed for awareness but loaded on demand, so outside the used count. */
  deferred?: true
}

/** The provider's own `/context` answer. */
export type AgentSessionContextReport = {
  /** Model the report was measured for. */
  model: string
  usedTokens: number
  windowTokens: number
  /** The provider's rounding, unclamped: an over-limit session reads above 100. */
  percentage: number
  /** Where the provider compacts on its own, when auto-compaction is on. */
  autoCompactAtTokens?: number
  categories: AgentSessionContextUsageCategory[]
  capturedAt: number
}

/** The main thread's window. After a model change the writer holds estimates until a new one lands. */
export type AgentSessionContextWindow = {
  tokens: number
  capturedAt: number
}

/** How much of the window is in use, as last learned. */
export type AgentSessionContextUsed =
  | ({ kind: 'report' } & AgentSessionContextReport)
  /** The newest main-thread response, whatever its blocks: its input is the
   *  live context size. A subagent's measures its own window. */
  | { kind: 'estimate'; usage: AgentSessionTokenUsage; capturedAt: number }
  /** Compaction, a conversation reset or a model change: unknown until a response or report restates it. */
  | { kind: 'unknown'; capturedAt: number }

/** Context facts on a turn row. An absent part says nothing. */
export type AgentSessionContextUsage = {
  window?: AgentSessionContextWindow
  used?: AgentSessionContextUsed
}
