import { describe, expect, it } from 'vitest'
import { foldBotStatus } from './bot-row-status'

describe('foldBotStatus', () => {
  it.each([
    ['monitoring', 'working'],
    ['permission', 'permission'],
    ['done', 'active']
  ] as const)('shows an available bot’s %s as %s', (status, folded) => {
    expect(foldBotStatus(status, false)).toBe(folded)
  })

  it.each([
    ['working', 'working'],
    ['permission', 'permission'],
    ['done', 'inactive']
  ] as const)('shows a paused bot’s %s as %s', (status, folded) => {
    expect(foldBotStatus(status, true)).toBe(folded)
  })
})
