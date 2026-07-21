// Why: Claude Code (>=2.1.80) pipes `rate_limits` to the statusLine command on every
// turn — piggybacked on Messages API responses, so reading it costs no usage-endpoint
// budget (the endpoint 429s under Orca's polling; see rate-limits/service.ts).

export const CLAUDE_STATUSLINE_PATHNAME = '/statusline/claude'

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
