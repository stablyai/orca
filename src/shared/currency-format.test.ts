import { describe, expect, it } from 'vitest'
import { formatCurrencyAmount } from './currency-format'

describe('formatCurrencyAmount', () => {
  it('formats USD amounts with the dollar symbol', () => {
    // Force a stable locale-independent expectation by asserting substrings.
    const formatted = formatCurrencyAmount(12.4, 'USD')
    expect(formatted).toMatch(/12[.,]40/)
    expect(formatted).toContain('$')
  })

  it('formats EUR amounts with the euro symbol and thousands separator', () => {
    const formatted = formatCurrencyAmount(2000, 'EUR')
    expect(formatted).toContain('€')
    expect(formatted).toMatch(/2[.,]000/)
  })

  it('falls back to code + amount for a malformed currency code', () => {
    // A non-3-letter code makes Intl.NumberFormat throw, exercising the fallback.
    expect(formatCurrencyAmount(9.5, 'ZZ')).toBe('ZZ 9.50')
  })

  it('defaults blank currency codes to USD', () => {
    expect(formatCurrencyAmount(1, '   ')).toContain('$')
  })

  it('treats non-finite amounts as zero', () => {
    expect(formatCurrencyAmount(Number.NaN, 'USD')).toMatch(/0[.,]00/)
  })
})
