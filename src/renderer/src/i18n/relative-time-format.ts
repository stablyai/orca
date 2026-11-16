import { getIntlLocale } from './i18n'

// Relative-time words follow the UI language; resolve plugin tags through getIntlLocale and cache per locale for live switches.
let cached: { locale: string; formatter: Intl.RelativeTimeFormat } | null = null

export function getUiRelativeTimeFormatter(
  intlLocale: string = getIntlLocale()
): Intl.RelativeTimeFormat {
  const locale = intlLocale
  if (!cached || cached.locale !== locale) {
    cached = { locale, formatter: new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }) }
  }
  return cached.formatter
}

export function formatUiRelativeTime(diffMs: number, intlLocale?: string): string {
  const formatter = getUiRelativeTimeFormatter(intlLocale)
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

export function formatUiRelativeTimeFromDate(
  input: string,
  fallback = 'recently',
  intlLocale?: string
): string {
  const date = new Date(input)
  if (Number.isNaN(date.getTime())) {
    return fallback
  }
  return formatUiRelativeTime(date.getTime() - Date.now(), intlLocale)
}

type NarrowTimeUnit = 'second' | 'minute' | 'hour' | 'day'

let narrowRelativeCache: { locale: string; formatter: Intl.RelativeTimeFormat } | null = null
const narrowDurationCache = new Map<string, Intl.NumberFormat>()

// Compact relative time ("in 5m", "8h ago") in the UI language.
export function formatUiNarrowRelativeTime(
  value: number,
  unit: NarrowTimeUnit,
  intlLocale: string = getIntlLocale()
): string {
  const locale = intlLocale
  if (!narrowRelativeCache || narrowRelativeCache.locale !== locale) {
    narrowRelativeCache = {
      locale,
      formatter: new Intl.RelativeTimeFormat(locale, { numeric: 'always', style: 'narrow' })
    }
  }
  return narrowRelativeCache.formatter.format(value, unit)
}

// Compact duration ("5m", "3h") in the UI language.
export function formatUiNarrowDuration(
  value: number,
  unit: NarrowTimeUnit,
  intlLocale: string = getIntlLocale()
): string {
  const locale = intlLocale
  const key = `${locale}\0${unit}`
  let formatter = narrowDurationCache.get(key)
  if (!formatter) {
    formatter = new Intl.NumberFormat(locale, { style: 'unit', unit, unitDisplay: 'narrow' })
    narrowDurationCache.set(key, formatter)
  }
  return formatter.format(value)
}
