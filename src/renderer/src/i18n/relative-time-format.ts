import { getIntlLocale } from './i18n'

// Why: relative times are language words ("2 days ago" / "그저께"), so they must follow the
// configured UI language rather than the OS locale — unlike Intl.DateTimeFormat, where numeric
// date shapes following the OS region is conventional. The language can change at runtime, and
// plugin packs register under a synthetic tag Intl rejects, so resolve through getIntlLocale()
// and cache per resolved locale rather than freezing one formatter at module scope.
let cached: { locale: string; formatter: Intl.RelativeTimeFormat } | null = null

export function getUiRelativeTimeFormatter(): Intl.RelativeTimeFormat {
  const locale = getIntlLocale()
  if (!cached || cached.locale !== locale) {
    cached = { locale, formatter: new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }) }
  }
  return cached.formatter
}

/** Format a signed millisecond delta (future positive, past negative) at minute/hour/day granularity. */
export function formatUiRelativeTime(diffMs: number): string {
  const formatter = getUiRelativeTimeFormatter()
  const diffMinutes = Math.round(diffMs / 60_000)
  if (Math.abs(diffMinutes) < 60) {
    return formatter.format(diffMinutes, 'minute')
  }
  const diffHours = Math.round(diffMinutes / 60)
  if (Math.abs(diffHours) < 24) {
    return formatter.format(diffHours, 'hour')
  }
  return formatter.format(Math.round(diffHours / 24), 'day')
}

/** Parse a date string and format it relative to now; returns `fallback` when the input is invalid. */
export function formatUiRelativeTimeFromDate(input: string, fallback = 'recently'): string {
  const date = new Date(input)
  if (Number.isNaN(date.getTime())) {
    return fallback
  }
  return formatUiRelativeTime(date.getTime() - Date.now())
}
