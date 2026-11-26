// Context facts replace their namesake on the open/newest turn; readers use the newest row carrying each part.

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
export const MAX_CONTEXT_CURRENCY_CHARS = 16

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

/** What the session has spent so far, as the provider totals it. */
export type AgentSessionCost = {
  amount: number
  /** ISO 4217 code, e.g. `USD`. */
  currency: string
  capturedAt: number
}

/** Where the agent compacts on its own, when it says so outside a `/context` report. */
export type AgentSessionAutoCompaction = {
  autoCompactAtTokens: number
  capturedAt: number
}

/** Context facts on a turn row. An absent part says nothing. */
export type AgentSessionContextUsage = {
  window?: AgentSessionContextWindow
  used?: AgentSessionContextUsed
  cost?: AgentSessionCost
  autoCompaction?: AgentSessionAutoCompaction
}
