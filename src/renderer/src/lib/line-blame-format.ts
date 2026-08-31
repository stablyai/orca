import { getUiRelativeTimeFormatter } from '@/i18n/relative-time-format'

// Why a coarser ladder than formatUiRelativeTime: that one stops at days, which
// would render most commits as "412 days ago".
const RELATIVE_UNITS: readonly [
  limit: number,
  divisor: number,
  unit: Intl.RelativeTimeFormatUnit
][] = [
  [60, 1, 'second'],
  [3600, 60, 'minute'],
  [86_400, 3600, 'hour'],
  [2_592_000, 86_400, 'day'],
  [31_536_000, 2_592_000, 'month']
]

/** Localized "3 months ago" for a commit time, or '' when the time is unusable. */
export function formatBlameRelativeTime(ms: number): string {
  // Non-finite guard: a missing/garbage author-time must not reach Intl, which
  // throws a RangeError on NaN.
  if (!Number.isFinite(ms)) {
    return ''
  }
  const formatter = getUiRelativeTimeFormatter()
  const deltaSec = Math.round((ms - Date.now()) / 1000)
  const abs = Math.abs(deltaSec)
  for (const [limit, divisor, unit] of RELATIVE_UNITS) {
    if (abs < limit) {
      return formatter.format(Math.round(deltaSec / divisor), unit)
    }
  }
  return formatter.format(Math.round(deltaSec / 31_536_000), 'year')
}

/** Absolute commit time in the app language, or '' when the time is unusable. */
export function formatBlameAbsoluteTime(ms: number): string {
  // Why undefined rather than the UI language: numeric date shapes conventionally
  // follow the OS region, the rule stated in i18n/relative-time-format.ts.
  return Number.isFinite(ms) ? new Date(ms).toLocaleString(undefined) : ''
}
