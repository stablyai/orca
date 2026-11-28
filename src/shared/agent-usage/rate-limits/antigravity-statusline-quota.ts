import { readClaudeStatusLineForm } from './claude-statusline-rate-limits'
import type { ProviderRateLimits, RateLimitBucket, RateLimitWindow } from './rate-limit-types'

// agy pipes its own quota to statusLine.command; Orca reads it instead of running agy (#50402).
export const ANTIGRAVITY_STATUSLINE_PATHNAME = '/statusline/antigravity'

const FIVE_HOUR_MINUTES = 300
const WEEKLY_MINUTES = 10080

type ParsedWindow = Pick<RateLimitWindow, 'usedPercent' | 'resetsAt'>

type QuotaPayload = {
  'gemini-5h'?: unknown
  'gemini-weekly'?: unknown
  '3p-5h'?: unknown
  '3p-weekly'?: unknown
}

/** Names the four independent pools agy reports; the status bar and details menu key off them. */
export const ANTIGRAVITY_POOL_LABELS = {
  gemini5h: 'Gemini 5h',
  geminiWeekly: 'Gemini weekly',
  thirdParty5h: 'Claude · GPT 5h',
  thirdPartyWeekly: 'Claude · GPT weekly'
} as const

function isQuotaPayload(value: unknown): value is QuotaPayload {
  return typeof value === 'object' && value !== null
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function parseWindow(value: unknown, receivedAt: number): ParsedWindow | null {
  if (typeof value !== 'object' || value === null || !('remaining_fraction' in value)) {
    return null
  }
  if ('disabled' in value && value.disabled === true) {
    return null
  }
  const remaining = finiteNumber(value.remaining_fraction)
  if (remaining === undefined) {
    return null
  }
  const used = (1 - Math.min(1, Math.max(0, remaining))) * 100
  const resetTime =
    'reset_time' in value && typeof value.reset_time === 'string'
      ? Date.parse(value.reset_time)
      : Number.NaN
  // Only a valid epoch or past reset means the window refilled; a bad value keeps its fraction.
  if (Number.isFinite(resetTime) && resetTime <= receivedAt) {
    return { usedPercent: 0, resetsAt: null }
  }
  return { usedPercent: used, resetsAt: Number.isFinite(resetTime) ? resetTime : null }
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

/** The reading holds only quota windows; the payload's email never leaves this function. */
export type AntigravityStatusLineReading = ProviderRateLimits

/** Null means the payload carries no usable quota window. `payload` is already-parsed JSON. */
export function readAntigravityStatusLineQuota(
  payload: unknown,
  receivedAt: number
): AntigravityStatusLineReading | null {
  const quota =
    typeof payload === 'object' && payload !== null && 'quota' in payload ? payload.quota : null
  if (!isQuotaPayload(quota)) {
    return null
  }
  const gemini5h = parseWindow(quota['gemini-5h'], receivedAt)
  const geminiWeekly = parseWindow(quota['gemini-weekly'], receivedAt)
  const thirdParty5h = parseWindow(quota['3p-5h'], receivedAt)
  const thirdPartyWeekly = parseWindow(quota['3p-weekly'], receivedAt)
  // Every present pool is a named bucket, so identical values in two pools stay separate rows.
  const buckets = [
    ...toBucket(gemini5h, ANTIGRAVITY_POOL_LABELS.gemini5h, FIVE_HOUR_MINUTES),
    ...toBucket(geminiWeekly, ANTIGRAVITY_POOL_LABELS.geminiWeekly, WEEKLY_MINUTES),
    ...toBucket(thirdParty5h, ANTIGRAVITY_POOL_LABELS.thirdParty5h, FIVE_HOUR_MINUTES),
    ...toBucket(thirdPartyWeekly, ANTIGRAVITY_POOL_LABELS.thirdPartyWeekly, WEEKLY_MINUTES)
  ]
  if (buckets.length === 0) {
    return null
  }
  return {
    provider: 'antigravity',
    session: toWindow(gemini5h, FIVE_HOUR_MINUTES),
    weekly: toWindow(geminiWeekly, WEEKLY_MINUTES),
    buckets,
    updatedAt: receivedAt,
    error: null,
    status: 'ok',
    usageMetadata: { source: 'live-session' }
  }
}

/** Reads the status-line form the managed script posts: `payload` carries agy's JSON. */
export function readAntigravityStatusLinePost(
  body: unknown,
  receivedAt: number
): AntigravityStatusLineReading | null {
  const form = readClaudeStatusLineForm(body)
  return form ? readAntigravityStatusLineQuota(form.payload, receivedAt) : null
}

/** The pool the status bar leads with: Gemini's windows, else the third-party 5h one. */
export function antigravityBarBuckets(
  buckets: readonly RateLimitBucket[] | undefined
): RateLimitBucket[] {
  const gemini = (buckets ?? []).filter(
    (bucket) =>
      bucket.name === ANTIGRAVITY_POOL_LABELS.gemini5h ||
      bucket.name === ANTIGRAVITY_POOL_LABELS.geminiWeekly
  )
  return gemini.length > 0
    ? gemini
    : (buckets ?? []).filter((bucket) => bucket.name === ANTIGRAVITY_POOL_LABELS.thirdParty5h)
}
