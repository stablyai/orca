import { getIntlLocale } from './i18n'

// Why: weekday names are language words, so they follow the configured UI language rather than
// the OS locale — same contract as relative-time-format.ts. The language can change at runtime
// and plugin packs register under a synthetic tag, so resolve through getIntlLocale() and cache
// per resolved locale instead of freezing one formatter at module scope.
let cached: { locale: string; names: readonly string[] } | null = null

// 2026-01-04 is a Sunday, so array index equals the cron/RRULE day-of-week number. Intl supplies
// names only, never ordering: many locales start the week on Monday while the persisted
// AutomationDraft.dayOfWeek stays Sunday-indexed.
const SUNDAY_UTC_MS = Date.UTC(2026, 0, 4)
const DAY_MS = 24 * 60 * 60 * 1000

/** Full weekday names in the UI language, Sunday first, indexed by cron day-of-week number. */
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
