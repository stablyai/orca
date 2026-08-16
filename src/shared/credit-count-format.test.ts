import { describe, expect, it } from 'vitest'
import { formatCreditCount } from './credit-count-format'

describe('formatCreditCount', () => {
  it('uses the viewer locale for grouped credit counts', () => {
    const expected = new Intl.NumberFormat(undefined, { maximumFractionDigits: 20 }).format(1234)
    expect(formatCreditCount(1234)).toBe(expected)
  })

  it('normalizes invalid and negative counts', () => {
    expect(formatCreditCount(Number.NaN)).toBe('0')
    expect(formatCreditCount(-5)).toBe('0')
  })
})
