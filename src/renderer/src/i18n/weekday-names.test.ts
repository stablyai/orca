import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockIntlLocale } = vi.hoisted(() => ({ mockIntlLocale: { value: 'en' } }))

vi.mock('./i18n', () => ({ getIntlLocale: () => mockIntlLocale.value }))

import { getUiWeekdayNames } from './weekday-names'

beforeEach(() => {
  mockIntlLocale.value = 'en'
})

describe('getUiWeekdayNames', () => {
  it('indexes names by cron day-of-week number, Sunday first', () => {
    expect(getUiWeekdayNames()).toEqual([
      'Sunday',
      'Monday',
      'Tuesday',
      'Wednesday',
      'Thursday',
      'Friday',
      'Saturday'
    ])
  })

  it.each([
    ['zh', '星期日', '星期一'],
    ['ja', '日曜日', '月曜日'],
    ['ko', '일요일', '월요일'],
    ['es', 'domingo', 'lunes']
  ])('names weekdays in the configured UI language (%s)', (locale, sunday, monday) => {
    mockIntlLocale.value = locale
    const names = getUiWeekdayNames()
    expect(names[0]).toBe(sunday)
    expect(names[1]).toBe(monday)
    expect(names).not.toContain('Monday')
  })

  it('reuses the cached names while the language is unchanged', () => {
    expect(getUiWeekdayNames()).toBe(getUiWeekdayNames())
  })

  it('rebuilds the names after a runtime language switch', () => {
    const english = getUiWeekdayNames()
    mockIntlLocale.value = 'ja'
    const japanese = getUiWeekdayNames()
    expect(japanese).not.toBe(english)
    expect(japanese[5]).toBe('金曜日')
  })
})
