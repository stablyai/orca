import { describe, expect, it } from 'vitest'
import { formatXlsxDate } from './xlsx-date-format'

const OPTIONS = { use1904DateSystem: false, locale: 'es-ES' }
// 2026-05-26, the first category of a real weight-tracking chart.
const MAY_26_2026 = 46168

describe('formatXlsxDate', () => {
  it('renders the code a chart axis carries', () => {
    // `d\-m` is what Excel wrote for that axis; the viewer showed 46168.
    expect(formatXlsxDate(MAY_26_2026, 'd\\-m', OPTIONS)).toBe('26-5')
  })

  it('renders padded and unpadded day, month and year', () => {
    expect(formatXlsxDate(MAY_26_2026, 'dd/mm/yyyy', OPTIONS)).toBe('26/05/2026')
    expect(formatXlsxDate(MAY_26_2026, 'd/m/yy', OPTIONS)).toBe('26/5/26')
  })

  it('renders month and weekday names in the viewer locale', () => {
    expect(formatXlsxDate(MAY_26_2026, 'd mmmm yyyy', OPTIONS)).toBe('26 mayo 2026')
    expect(formatXlsxDate(MAY_26_2026, 'mmm', OPTIONS)).toMatch(/^may/i)
    expect(formatXlsxDate(MAY_26_2026, 'dddd', { ...OPTIONS, locale: 'en-US' })).toBe('Tuesday')
  })

  it('tells a month apart from a minute by what surrounds it', () => {
    // Why: `m` is a month on its own and a minute beside an hour, which is the one
    // genuine ambiguity in the format language.
    const noon = MAY_26_2026 + 0.5
    expect(formatXlsxDate(noon, 'hh:mm', OPTIONS)).toBe('12:00')
    expect(formatXlsxDate(noon, 'mm', OPTIONS)).toBe('05')
    expect(formatXlsxDate(noon + 1 / 24 / 60, 'h:mm:ss', OPTIONS)).toBe('12:01:00')
  })

  it('switches to a twelve-hour clock when the code asks for a meridiem', () => {
    const evening = MAY_26_2026 + 13 / 24
    expect(formatXlsxDate(evening, 'h:mm AM/PM', OPTIONS)).toBe('1:00 PM')
    expect(formatXlsxDate(evening, 'h:mm', OPTIONS)).toBe('13:00')
    expect(formatXlsxDate(MAY_26_2026, 'h AM/PM', OPTIONS)).toBe('12 AM')
  })

  it('keeps quoted and escaped literals verbatim', () => {
    expect(formatXlsxDate(MAY_26_2026, 'd" de "mmmm', OPTIONS)).toBe('26 de mayo')
    expect(formatXlsxDate(MAY_26_2026, 'yyyy\\-mm\\-dd', OPTIONS)).toBe('2026-05-26')
  })

  it('drops a locale or colour bracket rather than printing it', () => {
    expect(formatXlsxDate(MAY_26_2026, '[$-409]dd/mm/yyyy', OPTIONS)).toBe('26/05/2026')
    expect(formatXlsxDate(MAY_26_2026, '[Red]dd/mm/yyyy', OPTIONS)).toBe('26/05/2026')
  })

  it('falls back to the ISO form for a code with no date token', () => {
    expect(formatXlsxDate(MAY_26_2026, '"texto"', OPTIONS)).toBe('2026-05-26')
    expect(formatXlsxDate(MAY_26_2026, '', OPTIONS)).toBe('2026-05-26')
  })

  it('falls back for the phantom leap day, which has no real date', () => {
    expect(formatXlsxDate(60, 'dd/mm/yyyy', OPTIONS)).toBe('1900-02-29')
  })

  it('honours the 1904 date system', () => {
    expect(formatXlsxDate(0, 'dd/mm/yyyy', { ...OPTIONS, use1904DateSystem: true })).toBe(
      '01/01/1904'
    )
  })

  it('returns the ISO fallback for a serial it cannot place', () => {
    expect(formatXlsxDate(-1, 'dd/mm/yyyy', OPTIONS)).toBeNull()
    expect(formatXlsxDate(Number.NaN, 'dd/mm/yyyy', OPTIONS)).toBeNull()
  })
})
