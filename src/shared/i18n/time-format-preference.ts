export type TimeFormatPreference = 'system' | '24h' | '12h'

export const DEFAULT_TIME_FORMAT_PREFERENCE: TimeFormatPreference = 'system'

const HOUR_CYCLES = { '24h': 'h23', '12h': 'h12' } as const

export type TimeFormatHourCycle = (typeof HOUR_CYCLES)[keyof typeof HOUR_CYCLES]

export function normalizeTimeFormatPreference(value: unknown): TimeFormatPreference {
  return value === '24h' || value === '12h' ? value : DEFAULT_TIME_FORMAT_PREFERENCE
}

export function applyTimeFormatHourCycle(locale: string, timeFormat: TimeFormatPreference): string {
  if (timeFormat === 'system') {
    return locale
  }
  try {
    return new Intl.Locale(locale, { hourCycle: HOUR_CYCLES[timeFormat] }).toString()
  } catch {
    return locale
  }
}

export function timeFormatHourCycle(
  timeFormat: TimeFormatPreference
): TimeFormatHourCycle | undefined {
  return timeFormat === 'system' ? undefined : HOUR_CYCLES[timeFormat]
}

export function localeHourCycle(locale: string | undefined): string | undefined {
  if (!locale) {
    return undefined
  }
  try {
    return new Intl.Locale(locale).hourCycle
  } catch {
    return undefined
  }
}
