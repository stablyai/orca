import { getIntlLocale } from './i18n'

// Why: relative times are language words ("2 days ago" / "그저께"), so they must follow the
// configured UI language rather than the OS locale — unlike Intl.DateTimeFormat, where numeric
// date shapes following the OS region is conventional. The language can change at runtime, and
// plugin packs register under a synthetic tag Intl rejects, so resolve through getIntlLocale()
// and cache per resolved locale rather than freezing one formatter at module scope.
type RelativeTimeFormatters = {
  locale: string
  wide: Intl.RelativeTimeFormat
  narrow: Intl.RelativeTimeFormat
}

let cached: RelativeTimeFormatters | null = null

function getRelativeTimeFormatters(): RelativeTimeFormatters {
  const locale = getIntlLocale()
  const existing = cached
  if (existing && existing.locale === locale) {
    return existing
  }
  const created: RelativeTimeFormatters = {
    locale,
    wide: new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }),
    // compact("5m ago") is the list-column width; wide("5 minutes ago") is prose.
    narrow: new Intl.RelativeTimeFormat(locale, { numeric: 'auto', style: 'narrow' })
  }
  cached = created
  return created
}

export function getUiRelativeTimeFormatter(): Intl.RelativeTimeFormat {
  return getRelativeTimeFormatters().wide
}

function formatRelativeTime(formatter: Intl.RelativeTimeFormat, diffMs: number): string {
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

/** Format a signed millisecond delta (future positive, past negative) at minute/hour/day granularity. */
export function formatUiRelativeTime(diffMs: number): string {
  return formatRelativeTime(getRelativeTimeFormatters().wide, diffMs)
}

/**
 * The compact counterpart dense columns use ("5m ago"). CLDR's narrow style is the shortest
 * form, and an engine may render a larger unit for the same delta than the wide form would.
 */
export function formatUiRelativeTimeCompact(diffMs: number): string {
  return formatRelativeTime(getRelativeTimeFormatters().narrow, diffMs)
}

/** Parse a date string and format it relative to now; returns `fallback` when the input is invalid. */
export function formatUiRelativeTimeFromDate(input: string, fallback = 'recently'): string {
  const date = new Date(input)
  if (Number.isNaN(date.getTime())) {
    return fallback
  }
  return formatUiRelativeTime(date.getTime() - Date.now())
}
