import { getIntlLocale } from './i18n'

// Weekday words follow the UI language; resolve synthetic plugin tags and cache per locale for live switches.
let cached: { locale: string; names: readonly string[] } | null = null

// 2026-01-04 is Sunday: preserve cron/RRULE Sunday indexing regardless of the locale’s first weekday.
const SUNDAY_UTC_MS = Date.UTC(2026, 0, 4)
const DAY_MS = 24 * 60 * 60 * 1000

export function getUiWeekdayNames(): readonly string[] {
  const locale = getIntlLocale()
  if (!cached || cached.locale !== locale) {
    const formatter = new Intl.DateTimeFormat(locale, { weekday: 'long', timeZone: 'UTC' })
    cached = {
      locale,
      names: Array.from({ length: 7 }, (_, index) =>
        formatter.format(new Date(SUNDAY_UTC_MS + index * DAY_MS))
      )
    }
  }
  return cached.names
}
