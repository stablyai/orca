import { afterEach, describe, expect, it, vi } from 'vitest'
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
  })

  it('gives a 24-hour hour its minutes so it never reads as a bare number', () => {
    const hourParts = (os: OsDateTimeRegion | null) => {
      setOsDateTimeRegion(os)
      return regionalDateTimeFormat({ hour: 'numeric' }, 'en')
        .formatToParts(new Date(2026, 10, 26, 20))
        .some((part) => part.type === 'minute')
    }
    expect(hourParts(null)).toBe(false)
    expect(hourParts({ region: 'US', hourCycle: 'h12' })).toBe(false)
    expect(hourParts({ region: 'US', hourCycle: 'h23' })).toBe(true)
  })

  it('keeps the UI script when the region implies another', () => {
    setOsDateTimeRegion({ region: 'TW', hourCycle: null })
    // Simplified 周, not the Traditional 週 a bare zh-TW would pick.
    expect(regionalDateTimeFormat({ weekday: 'short' }, 'zh').format(new Date(2026, 10, 26))).toBe(
      '周四'
    )
  })

  it("keeps the UI locale's calendar and other extension keywords", () => {
    setOsDateTimeRegion({ region: 'US', hourCycle: null })
    const options = regionalDateTimeFormat(DAY_CLOCK, 'en-u-ca-buddhist').resolvedOptions()
    expect(options.calendar).toBe('buddhist')
  })

  it('falls back to the UI language for a region it cannot use', () => {
    expect(shape('en', { region: 'not-a-region', hourCycle: null })).toMatchObject({
      locale: 'en',
      hourCycle: 'h12'
    })
  })

  it("uses the region's clock where ICU has no data for the language in that region", () => {
    // No ICU ships ko-DE, so it resolves to plain ko and its 12-hour clock.
    expect(shape('ko', { region: 'DE', hourCycle: null }).hourCycle).toBe('h23')
    expect(shape('ko', { region: 'RU', hourCycle: null }).hourCycle).toBe('h23')
    expect(shape('en', { region: 'US', hourCycle: null }).hourCycle).toBe('h12')
    // ICU knows fr-CA, which is 24-hour even though Canada's main language is not.
    expect(shape('fr', { region: 'CA', hourCycle: null }).hourCycle).toBe('h23')
  })

  it('reads an out-of-range date as "Invalid Date" instead of throwing', () => {
    setOsDateTimeRegion({ region: 'NL', hourCycle: null })
    const format = regionalDateTimeFormat(DAY_CLOCK, 'en')
    expect(format.format(Number.NaN)).toBe('Invalid Date')
    expect(format.format(new Date(8.64e15 + 1))).toBe('Invalid Date')
    expect(format.formatToParts(Number.NaN)).toEqual([{ type: 'literal', value: 'Invalid Date' }])
  })

  it('tells apart zones that share their January and July offsets', () => {
    const zone = process.env.TZ
    const at = Date.UTC(2026, 3, 15, 12)
    const hour = { hour: 'numeric', hourCycle: 'h23' } as const
    vi.useFakeTimers()
    try {
      process.env.TZ = 'Europe/Helsinki'
      expect(regionalDateTimeFormat(hour, 'en').format(at)).toBe('15')
      process.env.TZ = 'Africa/Cairo'
      vi.advanceTimersByTime(1_000)
      expect(regionalDateTimeFormat(hour, 'en').format(at)).toBe('14')
    } finally {
      process.env.TZ = zone
      vi.useRealTimers()
    }
  })

  it('follows a system time zone change instead of keeping the old zone', () => {
    const zone = process.env.TZ
    const at = Date.UTC(2026, 10, 26, 20, 5)
    const hour = { hour: 'numeric', hourCycle: 'h23' } as const
    try {
      process.env.TZ = 'UTC'
      expect(regionalDateTimeFormat(hour, 'en').format(at)).toBe('20')
      process.env.TZ = 'America/New_York'
      expect(regionalDateTimeFormat(hour, 'en').format(at)).toBe('15')
    } finally {
      process.env.TZ = zone
    }
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
