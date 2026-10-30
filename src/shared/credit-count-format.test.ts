import { describe, expect, it } from 'vitest'
import { formatCreditCount } from './credit-count-format'

describe('formatCreditCount', () => {
  it('uses the viewer locale for grouped credit counts', () => {
    const expected = new Intl.NumberFormat().format(1234)
    expect(formatCreditCount(1234)).toBe(expected)
  })

  it.each([
    [51809.811786, 51810],
    [1234.56789, 1235],
    [500.1, 500],
    [500.5, 501],
    [500, 500],
    [0.1, 0]
  ])('rounds %s to whole credits', (count, rounded) => {
    expect(formatCreditCount(count)).toBe(new Intl.NumberFormat().format(rounded))
  })

  it('normalizes invalid and negative counts', () => {
    expect(formatCreditCount(Number.NaN)).toBe('0')
    expect(formatCreditCount(-5)).toBe('0')
  })
})
