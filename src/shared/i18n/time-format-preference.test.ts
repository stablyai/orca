import { describe, expect, it } from 'vitest'
import {
  applyTimeFormatHourCycle,
  localeHourCycle,
  normalizeTimeFormatPreference
} from './time-format-preference'

describe('normalizeTimeFormatPreference', () => {
  it('keeps known values and turns anything else into system', () => {
    expect(normalizeTimeFormatPreference('24h')).toBe('24h')
    expect(normalizeTimeFormatPreference('12h')).toBe('12h')
    expect(normalizeTimeFormatPreference(undefined)).toBe('system')
    expect(normalizeTimeFormatPreference('h23')).toBe('system')
  })
})

describe('applyTimeFormatHourCycle', () => {
  it('leaves the locale untouched for system', () => {
    expect(applyTimeFormatHourCycle('en-US-u-ca-buddhist', 'system')).toBe('en-US-u-ca-buddhist')
  })

  it('adds the hour cycle while keeping script, region and other extensions', () => {
    expect(applyTimeFormatHourCycle('ko', '24h')).toBe('ko-u-hc-h23')
    expect(applyTimeFormatHourCycle('zh-Hant', '24h')).toBe('zh-Hant-u-hc-h23')
    expect(applyTimeFormatHourCycle('en-GB', '12h')).toBe('en-GB-u-hc-h12')
    expect(applyTimeFormatHourCycle('pt-BR', '12h')).toBe('pt-BR-u-hc-h12')
    expect(applyTimeFormatHourCycle('en-US-u-ca-buddhist', '24h')).toBe(
      'en-US-u-ca-buddhist-hc-h23'
    )
  })

  it('replaces an existing hour cycle without dropping sibling extensions', () => {
    expect(applyTimeFormatHourCycle('en-US-u-ca-buddhist-hc-h24', '24h')).toBe(
      'en-US-u-ca-buddhist-hc-h23'
    )
    expect(applyTimeFormatHourCycle('ja-JP-u-hc-h23-nu-latn', '12h')).toBe('ja-JP-u-hc-h12-nu-latn')
  })

  it('changes only the clock when formatting', () => {
    const date = new Date(Date.UTC(2026, 10, 27, 17, 58))
    const parts = (locale: string): { order: string[]; hour: string; dayPeriod: boolean } => {
      const formatted = new Intl.DateTimeFormat(locale, {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        timeZone: 'UTC'
      }).formatToParts(date)
      return {
        order: formatted
          .map((part) => part.type)
          .filter((type) => type === 'month' || type === 'day' || type === 'hour'),
        hour: formatted.find((part) => part.type === 'hour')?.value ?? '',
        dayPeriod: formatted.some((part) => part.type === 'dayPeriod')
      }
    }
    expect(parts(applyTimeFormatHourCycle('en', '24h'))).toEqual({
      order: ['month', 'day', 'hour'],
      hour: '17',
      dayPeriod: false
    })
    expect(parts(applyTimeFormatHourCycle('en-GB', '12h'))).toEqual({
      order: ['day', 'month', 'hour'],
      hour: '5',
      dayPeriod: true
    })
  })
})

describe('localeHourCycle', () => {
  it('reads the hc extension a locale pins', () => {
    expect(localeHourCycle('en-u-hc-h12')).toBe('h12')
    expect(localeHourCycle('en-GB')).toBeUndefined()
    expect(localeHourCycle(undefined)).toBeUndefined()
    expect(localeHourCycle('not a locale')).toBeUndefined()
  })
})
