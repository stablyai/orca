// Claude >=2.1.80 supplies rate_limits via statusLine from API responses, avoiding usage-endpoint polling that 429s under Orca.

export const CLAUDE_STATUSLINE_PATHNAME = '/statusline/claude'

// Statusline ticks ~3Hz; a 15s client floor bounds curl spawns while staying below the service’s 30s same-value dedupe window.
export const CLAUDE_STATUSLINE_MIN_POST_INTERVAL_SECONDS = 15

export type ClaudeStatusLineWindow = {
  used_percentage?: number
  /** OAuth-usage-shaped sibling field (0-100); accepted so a CLI schema drift degrades instead of going dark. */
  utilization?: number
  /** Unix epoch seconds when the window resets, if known; tolerates an ISO/date string if the schema drifts. */
  resets_at?: number | string
}

export type ClaudeStatusLineRateLimits = {
  /** CLAUDE_CONFIG_DIR of the reporting session; null for system-default sessions. */
  configDir: string | null
  fiveHour: ClaudeStatusLineWindow | null
  sevenDay: ClaudeStatusLineWindow | null
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function parseWindow(value: unknown): ClaudeStatusLineWindow | null {
  if (typeof value !== 'object' || value === null) {
    return null
  }
  const raw = value as { used_percentage?: unknown; utilization?: unknown; resets_at?: unknown }
  const usedPercentage = finiteNumber(raw.used_percentage)
  // Accept OAuth-shaped utilization (0–100) so schema renames degrade without losing the feed.
  const utilization = usedPercentage === undefined ? finiteNumber(raw.utilization) : undefined
  if (usedPercentage === undefined && utilization === undefined) {
    return null
  }
  // Accept ISO/string reset values on schema drift instead of dropping parseable timestamps.
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

/** Parse managed statusline form data; null means no usable rate-limit windows. */
export function parseClaudeStatusLineBody(body: unknown): ClaudeStatusLineRateLimits | null {
  if (typeof body !== 'object' || body === null) {
    return null
  }
  const fields = body as { payload?: unknown; configDir?: unknown }
  if (typeof fields.payload !== 'string' || !fields.payload) {
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
  const rateLimits = (payload as { rate_limits?: unknown }).rate_limits
  if (typeof rateLimits !== 'object' || rateLimits === null) {
    return null
  }
  const fiveHour = parseWindow((rateLimits as { five_hour?: unknown }).five_hour)
  const sevenDay = parseWindow((rateLimits as { seven_day?: unknown }).seven_day)
  if (!fiveHour && !sevenDay) {
    return null
  }
  const configDir = typeof fields.configDir === 'string' ? fields.configDir.trim() : ''
  return { configDir: configDir || null, fiveHour, sevenDay }
}
