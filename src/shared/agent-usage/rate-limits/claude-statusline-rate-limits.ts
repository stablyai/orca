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
  /** Reporting Claude session (payload session_id); null when the payload omits it. */
  sessionId?: string | null
  accountId?: string | null
  fiveHour: ClaudeStatusLineWindow | null
  sevenDay: ClaudeStatusLineWindow | null
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function parseWindow(value: unknown): ClaudeStatusLineWindow | null {
  if (!isRecord(value)) {
    return null
  }
  const usedPercentage = finiteNumber(value.used_percentage)
  // Accept OAuth-shaped utilization (0–100) so schema renames degrade without losing the feed.
  const utilization = usedPercentage === undefined ? finiteNumber(value.utilization) : undefined
  if (usedPercentage === undefined && utilization === undefined) {
    return null
  }
  // Accept ISO/string reset values on schema drift instead of dropping parseable timestamps.
  const resetsAt =
    typeof value.resets_at === 'number' && Number.isFinite(value.resets_at)
      ? value.resets_at
      : typeof value.resets_at === 'string' && value.resets_at.trim()
        ? value.resets_at
        : undefined
  return {
    ...(usedPercentage !== undefined ? { used_percentage: usedPercentage } : {}),
    ...(utilization !== undefined ? { utilization } : {}),
    resets_at: resetsAt
  }
}

export type ClaudeStatusLineForm = {
  fields: Record<string, unknown>
  payload: Record<string, unknown>
}

/** Parse the managed statusline form's JSON payload once for every reader of the post. */
export function readClaudeStatusLineForm(body: unknown): ClaudeStatusLineForm | null {
  if (!isRecord(body) || typeof body.payload !== 'string' || !body.payload) {
    return null
  }
  let payload: unknown
  try {
    payload = JSON.parse(body.payload)
  } catch {
    return null
  }
  return isRecord(payload) ? { fields: body, payload } : null
}

/** Null means no usable rate-limit windows. */
export function readClaudeStatusLineRateLimits({
  fields,
  payload
}: ClaudeStatusLineForm): ClaudeStatusLineRateLimits | null {
  const rateLimits = payload.rate_limits
  if (!isRecord(rateLimits)) {
    return null
  }
  const fiveHour = parseWindow(rateLimits.five_hour)
  const sevenDay = parseWindow(rateLimits.seven_day)
  if (!fiveHour && !sevenDay) {
    return null
  }
  const configDir = typeof fields.configDir === 'string' ? fields.configDir.trim() : ''
  const accountId = typeof fields.accountId === 'string' ? fields.accountId.trim() : ''
  const sessionId = typeof payload.session_id === 'string' ? payload.session_id : ''
  return {
    configDir: configDir || null,
    accountId: accountId || null,
    sessionId: sessionId || null,
    fiveHour,
    sevenDay
  }
}
