import type { RateLimitBucket } from './rate-limit-types'

export const ANTIGRAVITY_PRIMARY_FAMILY = 'Gemini Models'
export const ANTIGRAVITY_FIVE_HOUR_MINUTES = 300
export const ANTIGRAVITY_WEEKLY_MINUTES = 10080

export function getAntigravitySummaryBuckets(buckets: RateLimitBucket[]): RateLimitBucket[] {
  const primary = buckets.filter((bucket) =>
    bucket.name.startsWith(`${ANTIGRAVITY_PRIMARY_FAMILY} · `)
  )
  return [...(primary.length > 0 ? primary : buckets)].sort(
    (a, b) => a.windowMinutes - b.windowMinutes
  )
}
