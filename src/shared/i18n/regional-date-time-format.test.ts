import { afterEach, describe, expect, it } from 'vitest'
import {
  hourCycleFromTimePattern,
  osLocaleRegion,
  regionalDateTimeFormat,
  setOsDateTimeRegion,
  type OsDateTimeRegion
} from './regional-date-time-format'

const DAY_CLOCK = { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' } as const

// Whole strings vary by ICU version; the locale, clock and day/month order are what the OS decides.
function shape(
  uiLocale: string,
  os: OsDateTimeRegion | null,
  options: Intl.DateTimeFormatOptions = DAY_CLOCK
) {
  setOsDateTimeRegion(os)
  const formatter = regionalDateTimeFormat(options, uiLocale)
  const order = formatter
    .formatToParts(new Date(2026, 10, 26, 20, 5))
    .map((part) => part.type)
    .filter((type) => type === 'day' || type === 'month')
    .join('-')
  const { locale, hourCycle } = formatter.resolvedOptions()
  return { locale, hourCycle, order }
}

afterEach(() => setOsDateTimeRegion(null))

describe('regionalDateTimeFormat', () => {
  it('keeps the UI language but takes the clock and day order from the OS', () => {
    expect(shape('en', null)).toEqual({ locale: 'en', hourCycle: 'h12', order: 'month-day' })
    expect(shape('en', { region: 'NL', hourCycle: null })).toEqual({
      locale: 'en-NL',
      hourCycle: 'h23',
      order: 'day-month'
    })
    expect(shape('en', { region: 'US', hourCycle: 'h23' })).toMatchObject({ hourCycle: 'h23' })
    expect(shape('en', { region: 'GB', hourCycle: 'h12' })).toMatchObject({ hourCycle: 'h12' })
    expect(shape('de', { region: 'US', hourCycle: 'h23' }).hourCycle).toBe('h23')
    expect(shape('ja', { region: 'US', hourCycle: 'h12' }).hourCycle).toMatch(/^h1[12]$/)
  })

  it('keeps the UI script when the region implies another', () => {
    setOsDateTimeRegion({ region: 'TW', hourCycle: null })
    // Simplified 周, not the Traditional 週 a bare zh-TW would pick.
    expect(regionalDateTimeFormat({ weekday: 'short' }, 'zh').format(new Date(2026, 10, 26))).toBe(
      '周四'
    )
  })

  it('falls back to the UI language for a region it cannot use', () => {
    expect(shape('en', { region: 'not-a-region', hourCycle: null })).toMatchObject({
      locale: 'en',
      hourCycle: 'h12'
    })
    expect(shape('en', { region: 'AQ', hourCycle: null }).hourCycle).toBe('h12')
  })
})

describe('OS locale readers', () => {
  it('reads the region from macOS, Linux and BCP-47 tags', () => {
    expect(osLocaleRegion('en-US@rg=nlzzzz')).toBe('NL')
    expect(osLocaleRegion('en_GB.UTF-8')).toBe('GB')
    expect(osLocaleRegion('zh-Hant-TW')).toBe('TW')
    expect(osLocaleRegion('es-419')).toBe('419')
    expect(osLocaleRegion('C.UTF-8')).toBeNull()
  })

  it('reads the hour cycle from a Windows short-time pattern', () => {
    expect(hourCycleFromTimePattern('HH:mm')).toBe('h23')
    expect(hourCycleFromTimePattern('h:mm tt')).toBe('h12')
    expect(hourCycleFromTimePattern("H 'h' mm")).toBe('h23')
  })
})
