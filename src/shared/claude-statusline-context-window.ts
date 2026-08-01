// Why: Claude Code pipes a `context_window` object to the statusLine command on
// every turn (total_input_tokens, context_window_size, current_usage breakdown).
// Sibling of claude-statusline-rate-limits.ts: same POST body, different payload
// field, feeding per-pane AgentStatusEntry.contextUsage instead of RateLimitService.

import { normalizeAgentContextUsage, type AgentContextUsage } from './agent-context-pressure'

/** Substring gate shared with the managed statusline scripts (POSIX case / findstr). */
export const CLAUDE_STATUSLINE_CONTEXT_WINDOW_KEY = 'context_window'

export type ClaudeStatusLineContextUsage = {
  /** Pane the reporting session runs in (form field stamped by the managed script). */
  paneKey: string
  usage: AgentContextUsage
  sessionId?: string
}

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

// Sum of the last API call's input-side tokens = current context occupancy.
// Why current_usage over total_input_tokens: pre-v2.1.132 the totals were
// cumulative session counters, so summing the per-call breakdown is the only
// reading that is honest on every CLI version.
function currentUsageTokens(value: unknown): number | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined
  }
  const raw = value as Record<string, unknown>
  const input = finiteNonNegative(raw.input_tokens)
  const cacheCreation = finiteNonNegative(raw.cache_creation_input_tokens)
  const cacheRead = finiteNonNegative(raw.cache_read_input_tokens)
  if (input === undefined && cacheCreation === undefined && cacheRead === undefined) {
    return undefined
  }
  return (input ?? 0) + (cacheCreation ?? 0) + (cacheRead ?? 0)
}

/**
 * Parses the form-encoded body posted by the managed Claude statusline script
 * into a per-pane context reading. Returns null when the payload carries no
 * real token numbers — booleans like `exceeds_200k_tokens` never fabricate one.
 */
export function parseClaudeStatusLineContextUsage(
  body: unknown
): ClaudeStatusLineContextUsage | null {
  if (typeof body !== 'object' || body === null) {
    return null
  }
  const fields = body as { payload?: unknown; paneKey?: unknown }
  const paneKey = typeof fields.paneKey === 'string' ? fields.paneKey.trim() : ''
  if (!paneKey || typeof fields.payload !== 'string' || !fields.payload) {
    return null
  }
  let payload: unknown
  try {
    payload = JSON.parse(fields.payload)
  } catch {
    return null
  }
  if (typeof payload !== 'object' || payload === null) {
    return null
  }
  const contextWindow = (payload as { context_window?: unknown }).context_window
  if (typeof contextWindow !== 'object' || contextWindow === null || Array.isArray(contextWindow)) {
    return null
  }
  const raw = contextWindow as Record<string, unknown>
  const model = (payload as { model?: unknown }).model
  const providerId =
    typeof model === 'object' && model !== null && !Array.isArray(model)
      ? (model as Record<string, unknown>).provider
      : undefined
  const maxTokens =
    typeof raw.context_window_size === 'number' &&
    Number.isFinite(raw.context_window_size) &&
    raw.context_window_size >= 1
      ? raw.context_window_size
      : undefined
  let usedTokens = currentUsageTokens(raw.current_usage)
  let usedTokensSource: AgentContextUsage['usedTokensSource'] = 'provider'
  if (usedTokens === undefined) {
    // Why: used_percentage has always been context-relative, so deriving from it
    // stays honest when current_usage is null (pre-first-response / post-compact);
    // it needs the window size to yield tokens.
    const usedPercentage = finiteNonNegative(raw.used_percentage)
    if (usedPercentage !== undefined && maxTokens !== undefined) {
      usedTokens = Math.round((usedPercentage / 100) * maxTokens)
      usedTokensSource = 'derived-percent'
    }
  }
  if (usedTokens === undefined) {
    return null
  }
  const usage = normalizeAgentContextUsage({
    usedTokens,
    maxTokens,
    usedTokensSource,
    ...(typeof providerId === 'string' ? { providerId } : {})
  })
  const sessionId = (payload as { session_id?: unknown }).session_id
  return usage
    ? {
        paneKey,
        usage,
        ...(typeof sessionId === 'string' && sessionId.trim()
          ? { sessionId: sessionId.trim() }
          : {})
      }
    : null
}
