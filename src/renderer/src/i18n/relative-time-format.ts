import { getIntlLocale } from './i18n'

// Relative-time words follow the UI language; resolve plugin tags through getIntlLocale and cache per locale for live switches.
let cached: { locale: string; formatter: Intl.RelativeTimeFormat } | null = null

export function getUiRelativeTimeFormatter(): Intl.RelativeTimeFormat {
  const locale = getIntlLocale()
  if (!cached || cached.locale !== locale) {
    cached = { locale, formatter: new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }) }
  }
  return cached.formatter
}

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

export function formatUiRelativeTimeFromDate(input: string, fallback = 'recently'): string {
  const date = new Date(input)
  if (Number.isNaN(date.getTime())) {
    return fallback
  }
  return formatUiRelativeTime(date.getTime() - Date.now())
}
