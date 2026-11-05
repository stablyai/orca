import { expect, it } from 'vitest'
import { formatCost, formatTokens } from './usage-formatters'

it('formats token and cost values for compact UI labels', () => {
  expect(formatTokens(999)).toBe('999')
  expect(formatTokens(1_200)).toBe('1.2k')
  expect(formatTokens(2_500_000)).toBe('2.5M')
  expect(formatTokens(58_621_296_970)).toBe('58.6B')
  expect(formatCost(null)).toBe('n/a')
  expect(formatCost(0.0042)).toBe('$0.0042')
  expect(formatCost(1.234)).toBe('$1.23')
})
