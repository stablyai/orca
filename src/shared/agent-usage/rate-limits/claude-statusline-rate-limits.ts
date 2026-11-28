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
  /** Reporting Orca pane (form paneKey); null when the form omits it. */
  paneKey?: string | null
  /** Reporting Claude session (payload session_id); null when the payload omits it. */
  sessionId?: string | null
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

export type ClaudeStatusLineForm = {
  fields: object
  payload: object
}

/** Parse the managed statusline form's JSON payload once for every reader of the post. */
export function readClaudeStatusLineForm(body: unknown): ClaudeStatusLineForm | null {
  if (typeof body !== 'object' || body === null || !('payload' in body)) {
    return null
  }
  if (typeof body.payload !== 'string' || !body.payload) {
    return null
  }
  let payload: unknown
  try {
    payload = JSON.parse(body.payload)
  } catch {
    return null
  }
  return typeof payload === 'object' && payload !== null ? { fields: body, payload } : null
}

/** Null means no usable rate-limit windows. */
export function readClaudeStatusLineRateLimits({
  fields,
  payload
}: ClaudeStatusLineForm): ClaudeStatusLineRateLimits | null {
  const rateLimits = 'rate_limits' in payload ? payload.rate_limits : undefined
  if (typeof rateLimits !== 'object' || rateLimits === null) {
    return null
  }
  const fiveHour = parseWindow('five_hour' in rateLimits ? rateLimits.five_hour : undefined)
  const sevenDay = parseWindow('seven_day' in rateLimits ? rateLimits.seven_day : undefined)
  if (!fiveHour && !sevenDay) {
    return null
  }
  const configDir =
    'configDir' in fields && typeof fields.configDir === 'string' ? fields.configDir.trim() : ''
  const paneKey =
    'paneKey' in fields && typeof fields.paneKey === 'string' ? fields.paneKey.trim() : ''
  const sessionId =
    'session_id' in payload && typeof payload.session_id === 'string' ? payload.session_id : ''
  return {
    configDir: configDir || null,
    paneKey: paneKey || null,
    sessionId: sessionId || null,
    fiveHour,
    sevenDay
  }
}
