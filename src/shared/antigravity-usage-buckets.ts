/**
 * Antigravity's own quota (from the local runtime's `RetrieveUserQuotaSummary`
 * call) groups models into two pools that each carry an independent weekly and
 * five-hour limit. There is no single "session"/"weekly" pair the way most
 * other providers report, so all four numbers are surfaced as named buckets
 * (the same mechanism Gemini's per-model buckets and Cursor's plan pools use)
 * instead of new fields on ProviderRateLimits.
 */
export const ANTIGRAVITY_GEMINI_FIVE_HOUR_BUCKET_NAME = 'Gemini 5h'
export const ANTIGRAVITY_GEMINI_WEEKLY_BUCKET_NAME = 'Gemini Weekly'
export const ANTIGRAVITY_THIRD_PARTY_FIVE_HOUR_BUCKET_NAME = 'Claude/GPT 5h'
export const ANTIGRAVITY_THIRD_PARTY_WEEKLY_BUCKET_NAME = 'Claude/GPT Weekly'

export const ANTIGRAVITY_USAGE_BUCKET_NAMES = [
  ANTIGRAVITY_GEMINI_FIVE_HOUR_BUCKET_NAME,
  ANTIGRAVITY_GEMINI_WEEKLY_BUCKET_NAME,
  ANTIGRAVITY_THIRD_PARTY_FIVE_HOUR_BUCKET_NAME,
  ANTIGRAVITY_THIRD_PARTY_WEEKLY_BUCKET_NAME
] as const

export function isAntigravityUsageBucket(name: string): boolean {
  return (ANTIGRAVITY_USAGE_BUCKET_NAMES as readonly string[]).includes(name)
}
