import { afterEach, expect, it } from 'vitest'
import { i18n } from '@/i18n/i18n'
import { formatCost, formatTokens } from './usage-formatters'

const originalLanguage = i18n.language

afterEach(async () => {
  await i18n.changeLanguage(originalLanguage)
})

it('formats token and cost values for compact UI labels', () => {
  expect(formatTokens(999)).toBe('999')
  expect(formatTokens(1_200)).toBe('1.2k')
  expect(formatTokens(2_500_000)).toBe('2.5M')
  expect(formatTokens(58_621_296_970)).toBe('58.6B')
  expect(formatCost(null)).toBe('n/a')
  expect(formatCost(0.0042)).toBe('$0.0042')
  expect(formatCost(1.234)).toBe('$1.23')
})

it('formats the billion tier with the active locale', async () => {
  await i18n.changeLanguage('es')
  expect(formatTokens(58_621_296_970).replace(/\s/g, ' ')).toBe('58,6 mil M')
})
