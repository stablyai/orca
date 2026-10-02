// Why: Claude Code (>=2.1.80) pipes `rate_limits` to the statusLine command on every
// turn — piggybacked on Messages API responses, so reading it costs no usage-endpoint
// budget (the endpoint 429s under Orca's polling; see rate-limits/service.ts).

import { isRecord } from './agent-status-child-work-value-guards'

export const CLAUDE_STATUSLINE_PATHNAME = '/statusline/claude'

// Why: the statusline ticks ~3x/sec while streaming and the service drops same-value posts
// inside LIVE_CLAUDE_INGEST_DEDUPE_MS (30s) anyway; a per-pane client floor below that bound
// keeps the usage bar live while capping curl spawns at one per pane per interval.
export const CLAUDE_STATUSLINE_MIN_POST_INTERVAL_SECONDS = 15

export type ClaudeStatusLineWindow = {
  used_percentage?: number
  /** OAuth-usage-shaped sibling field (0-100); accepted so a CLI schema drift degrades instead of going dark. */
  utilization?: number
  /** Unix epoch seconds when the window resets, if known; tolerates an ISO/date string if the schema drifts. */
  resets_at?: number | string
}

export type ClaudeStatusLineRateLimits = {
  agent?: 'claude' | 'openclaude'
  /** CLAUDE_CONFIG_DIR of the reporting session; null for system-default sessions. */
  configDir: string | null
  /** Stable Orca pane identity supplied by the managed statusline command. */
  paneKey?: string
  /** Provider model id for this exact Claude session. */
  model?: string
  /** Provider effort for this exact Claude session, when reported. */
  effort?: string
  fiveHour: ClaudeStatusLineWindow | null
  sevenDay: ClaudeStatusLineWindow | null
  context?: ClaudeStatusLineContext
}

export type ClaudeStatusLineContext = {
  usedTokens: number | null
  maxTokens: number
  remainingTokens: number | null
  usedPercent: number
  estimated?: boolean
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function parseWindow(value: unknown): ClaudeStatusLineWindow | null {
  if (!isRecord(value)) {
    return null
  }
  const raw = value
  const usedPercentage = finiteNumber(raw.used_percentage)
  // Why: mirror mapClaudeUsageWindow's OAuth-shape tolerance (utilization, 0-100) so a statusline field rename degrades instead of silently darkening the feed.
  const utilization = usedPercentage === undefined ? finiteNumber(raw.utilization) : undefined
  if (usedPercentage === undefined && utilization === undefined) {
    return null
  }
  // Why: resets_at is epoch seconds today, but pass a string/ISO value through so schema drift degrades to a parseable timestamp (see parseClaudeUsageResetTimestamp) instead of silently dropping it.
  const resetsAt =
    typeof raw.resets_at === 'number' && Number.isFinite(raw.resets_at)
      ? raw.resets_at
      : typeof raw.resets_at === 'string' && raw.resets_at.trim()
        ? raw.resets_at
        : undefined
  return {
    ...(usedPercentage !== undefined ? { used_percentage: usedPercentage } : {}),
    ...(utilization !== undefined ? { utilization } : {}),
    resets_at: resetsAt
  }
}

/**
 * Parses the form-encoded body posted by the managed Claude statusline script.
 * Returns null when the payload carries no usable rate-limit windows.
 */
export function parseClaudeStatusLineBody(body: unknown): ClaudeStatusLineRateLimits | null {
  if (!isRecord(body)) {
    return null
  }
  const fields = body
  if (typeof fields.payload !== 'string' || !fields.payload) {
    return null
  }
  let payload: unknown
  try {
    payload = JSON.parse(fields.payload)
  } catch {
    return null
  }
  if (!isRecord(payload)) {
    return null
  }
  const payloadRecord = payload
  const rateLimits = isRecord(payloadRecord.rate_limits) ? payloadRecord.rate_limits : null
  const fiveHour = parseWindow(rateLimits?.five_hour)
  const sevenDay = parseWindow(rateLimits?.seven_day)
  const context = parseContext(payloadRecord.context_window)
  const modelRecord = isRecord(payloadRecord.model) ? payloadRecord.model : null
  const model = [modelRecord?.id, modelRecord?.display_name, payloadRecord.model]
    .find((value) => typeof value === 'string' && value.trim())
    ?.toString()
    .trim()
  const effort = [payloadRecord.effort, payloadRecord.effort_level]
    .find((value) => typeof value === 'string' && value.trim())
    ?.toString()
    .trim()
  if (!fiveHour && !sevenDay && !context && !model && !effort) {
    return null
  }
  const configDir = typeof fields.configDir === 'string' ? fields.configDir.trim() : ''
  const paneKey = typeof fields.paneKey === 'string' ? fields.paneKey.trim().slice(0, 512) : ''
  return {
    ...(fields.agent === 'openclaude' ? { agent: 'openclaude' as const } : {}),
    configDir: configDir || null,
    fiveHour,
    sevenDay,
    ...(paneKey ? { paneKey } : {}),
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    ...(context ? { context } : {})
  }
}

function parseContext(value: unknown): ClaudeStatusLineContext | null {
  if (!isRecord(value)) {
    return null
  }
  const raw = value
  const maxTokens = finiteNumber(raw.context_window_size)
  const current = isRecord(raw.current_usage) ? raw.current_usage : null
  const input = finiteNumber(current?.input_tokens)
  const cacheCreation = finiteNumber(current?.cache_creation_input_tokens)
  const cacheRead = finiteNumber(current?.cache_read_input_tokens)
  const usedTokens =
    input === undefined && cacheCreation === undefined && cacheRead === undefined
      ? null
      : (input ?? 0) + (cacheCreation ?? 0) + (cacheRead ?? 0)
  const reportedPercent = finiteNumber(raw.used_percentage)
  if (!maxTokens || maxTokens <= 0 || (reportedPercent === undefined && usedTokens === null)) {
    return null
  }
  const usedPercent = reportedPercent ?? (usedTokens! / maxTokens) * 100
  if (usedPercent < 0) {
    return null
  }
  return {
    usedTokens,
    maxTokens,
    remainingTokens: usedTokens === null ? null : Math.max(0, maxTokens - usedTokens),
    usedPercent: Math.min(100, usedPercent),
    ...(current?.is_estimated === true ? { estimated: true } : {})
  }
}
