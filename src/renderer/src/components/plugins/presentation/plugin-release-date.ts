import { getIntlLocale } from '@/i18n/i18n'
import { uiDateTimeFormat } from '@/i18n/ui-intl-formatters'
const RELEASE_DAY: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', year: 'numeric' }
const RELEASE_DAY_UTC: Intl.DateTimeFormatOptions = { ...RELEASE_DAY, timeZone: 'UTC' }

/** A catalog release date ("2026-10-20" or a date-time) as a short local date; null if unreadable. */
export function formatPluginReleaseDate(
  value: string | undefined,
  intlLocale: string = getIntlLocale()
): string | null {
  if (!value) {
    return null
  }
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value)
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return null
  }
  // Why: a bare date parses as UTC midnight, which is the previous day west of UTC.
  return uiDateTimeFormat(dateOnly ? RELEASE_DAY_UTC : RELEASE_DAY, intlLocale).format(date)
}
