import type { ProviderRateLimits, RateLimitBucket, RateLimitWindow } from './rate-limit-types'

// agy pipes its own quota to statusLine.command; Orca reads it instead of running agy (#50402).
export const ANTIGRAVITY_STATUSLINE_PATHNAME = '/statusline/antigravity'

const FIVE_HOUR_MINUTES = 300
const WEEKLY_MINUTES = 10080

type ParsedWindow = Pick<RateLimitWindow, 'usedPercent' | 'resetsAt'>

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function parseWindow(value: unknown, receivedAt: number): ParsedWindow | null {
  if (typeof value !== 'object' || value === null || !('remaining_fraction' in value)) {
    return null
  }
  const remaining = finiteNumber(value.remaining_fraction)
  if (remaining === undefined) {
    return null
  }
  const resetTime =
    'reset_time' in value && typeof value.reset_time === 'string'
      ? Date.parse(value.reset_time)
      : Number.NaN
  // An untouched window reports the epoch and a lapsed one only refills, so both read 0% used.
  if (!(resetTime > 0) || resetTime <= receivedAt) {
    return { usedPercent: 0, resetsAt: null }
  }
  return { usedPercent: (1 - Math.min(1, Math.max(0, remaining))) * 100, resetsAt: resetTime }
}

function toWindow(parsed: ParsedWindow | null, windowMinutes: number): RateLimitWindow | null {
  return parsed ? { ...parsed, windowMinutes, resetDescription: null } : null
}

function toBucket(
  parsed: ParsedWindow | null,
  name: string,
  windowMinutes: number
): RateLimitBucket[] {
  const window = toWindow(parsed, windowMinutes)
  return window ? [{ ...window, name }] : []
}

/** Null means the payload carries no usable quota window; the email only attributes the reading. */
export function readAntigravityStatusLineQuota(
  payloadJson: string,
  receivedAt: number
): { email: string | null; limits: ProviderRateLimits } | null {
  let payload: unknown
  try {
    payload = JSON.parse(payloadJson)
  } catch {
    return null
  }
  if (typeof payload !== 'object' || payload === null || !('quota' in payload)) {
    return null
  }
  const quota = payload.quota
  if (typeof quota !== 'object' || quota === null) {
    return null
  }
  const read = (key: string): ParsedWindow | null =>
    parseWindow(key in quota ? (quota as Record<string, unknown>)[key] : undefined, receivedAt)
  const session = toWindow(read('gemini-5h'), FIVE_HOUR_MINUTES)
  const weekly = toWindow(read('gemini-weekly'), WEEKLY_MINUTES)
  const buckets = [
    ...toBucket(read('3p-5h'), 'Claude · GPT 5h', FIVE_HOUR_MINUTES),
    ...toBucket(read('3p-weekly'), 'Claude · GPT weekly', WEEKLY_MINUTES)
  ]
  if (!session && !weekly && buckets.length === 0) {
    return null
  }
  const email = 'email' in payload && typeof payload.email === 'string' ? payload.email.trim() : ''
  return {
    email: email || null,
    limits: {
      provider: 'antigravity',
      session,
      weekly,
      ...(buckets.length > 0 ? { buckets } : {}),
      updatedAt: receivedAt,
      error: null,
      status: 'ok',
      usageMetadata: { source: 'live-session' }
    }
  }
}
