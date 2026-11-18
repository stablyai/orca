import { describe, expect, it } from 'vitest'
import { foldBotStatus } from './bot-row-status'

describe('foldBotStatus', () => {
  it.each([
    ['working', 'working'],
    ['monitoring', 'working'],
    ['permission', 'permission'],
    ['done', 'active'],
    ['failed', 'active'],
    ['interrupted', 'active'],
    ['unconfirmed', 'active'],
    ['active', 'active'],
    ['inactive', 'active']
  ] as const)('shows an available bot’s %s as %s', (status, folded) => {
    expect(foldBotStatus(status, false)).toBe(folded)
  })

  it.each([
    ['working', 'working'],
    ['permission', 'permission'],
    ['done', 'inactive'],
    ['inactive', 'inactive']
  ] as const)('shows a paused bot’s %s as %s', (status, folded) => {
    expect(foldBotStatus(status, true)).toBe(folded)
  })
})
