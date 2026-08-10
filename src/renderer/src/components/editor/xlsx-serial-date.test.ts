import { describe, expect, it } from 'vitest'
import { formatXlsxSerialDate } from './xlsx-serial-date'

const NINETEEN_HUNDRED = { use1904DateSystem: false }
const NINETEEN_OH_FOUR = { use1904DateSystem: true }

describe('formatXlsxSerialDate in the 1900 date system', () => {
  it('renders whole-day serials as a date', () => {
    expect(formatXlsxSerialDate(1, NINETEEN_HUNDRED)).toBe('1900-01-01')
    expect(formatXlsxSerialDate(59, NINETEEN_HUNDRED)).toBe('1900-02-28')
    expect(formatXlsxSerialDate(61, NINETEEN_HUNDRED)).toBe('1900-03-01')
    expect(formatXlsxSerialDate(45_658, NINETEEN_HUNDRED)).toBe('2025-01-01')
  })

  it('renders serial 60 as the phantom leap day Excel stores there', () => {
    // Why: Excel keeps 1900-02-29 for Lotus 1-2-3 compatibility even though it
    // never existed. Anything else would misdate every serial around it.
    expect(formatXlsxSerialDate(60, NINETEEN_HUNDRED)).toBe('1900-02-29')
    expect(formatXlsxSerialDate(60.5, NINETEEN_HUNDRED)).toBe('1900-02-29 12:00:00')
  })

  it('appends a time when the serial carries a fraction', () => {
    expect(formatXlsxSerialDate(45_658.5, NINETEEN_HUNDRED)).toBe('2025-01-01 12:00:00')
    expect(formatXlsxSerialDate(45_658.75, NINETEEN_HUNDRED)).toBe('2025-01-01 18:00:00')
  })

  it('renders a sub-day serial as a bare time', () => {
    expect(formatXlsxSerialDate(0, NINETEEN_HUNDRED)).toBe('00:00:00')
    expect(formatXlsxSerialDate(0.5, NINETEEN_HUNDRED)).toBe('12:00:00')
    expect(formatXlsxSerialDate(0.7506944444444444, NINETEEN_HUNDRED)).toBe('18:01:00')
  })

  it('carries a fraction that rounds up to midnight into the next day', () => {
    expect(formatXlsxSerialDate(45_658.9999999, NINETEEN_HUNDRED)).toBe('2025-01-02')
    expect(formatXlsxSerialDate(0.9999999, NINETEEN_HUNDRED)).toBe('1900-01-01')
  })

  it('rounds a fractional second to the nearest whole second', () => {
    const oneSecondAndAHalf = 1.5 / 86_400
    expect(formatXlsxSerialDate(45_658 + oneSecondAndAHalf, NINETEEN_HUNDRED)).toBe(
      '2025-01-01 00:00:02'
    )
  })

  it('renders dates past the year 2000 leap day correctly', () => {
    expect(formatXlsxSerialDate(36_585, NINETEEN_HUNDRED)).toBe('2000-02-29')
    expect(formatXlsxSerialDate(36_586, NINETEEN_HUNDRED)).toBe('2000-03-01')
  })

  it('renders the last date Excel can store', () => {
    expect(formatXlsxSerialDate(2_958_465, NINETEEN_HUNDRED)).toBe('9999-12-31')
  })
})

describe('formatXlsxSerialDate in the 1904 date system', () => {
  it('anchors serial 0 at 1904-01-01', () => {
    expect(formatXlsxSerialDate(0, NINETEEN_OH_FOUR)).toBe('1904-01-01')
    expect(formatXlsxSerialDate(1, NINETEEN_OH_FOUR)).toBe('1904-01-02')
  })

  it('has no phantom leap day', () => {
    expect(formatXlsxSerialDate(60, NINETEEN_OH_FOUR)).toBe('1904-03-01')
  })

  it('is offset from the 1900 system by 1462 days', () => {
    // Why: the two systems disagree by exactly four years plus one leap day, so
    // reading a Mac-authored workbook with the wrong anchor misdates every value.
    expect(formatXlsxSerialDate(45_658 - 1462, NINETEEN_OH_FOUR)).toBe('2025-01-01')
  })
})

describe('formatXlsxSerialDate rejections', () => {
  it('returns null for values that cannot be a date serial', () => {
    expect(formatXlsxSerialDate(-1, NINETEEN_HUNDRED)).toBeNull()
    expect(formatXlsxSerialDate(Number.NaN, NINETEEN_HUNDRED)).toBeNull()
    expect(formatXlsxSerialDate(Number.POSITIVE_INFINITY, NINETEEN_HUNDRED)).toBeNull()
  })

  it('returns null instead of an invalid date for an absurd serial', () => {
    expect(formatXlsxSerialDate(1e15, NINETEEN_HUNDRED)).toBeNull()
  })
})
