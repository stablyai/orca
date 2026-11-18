import { describe, expect, it } from 'vitest'
import { foldBotStatus } from './bot-row-status'

describe('foldBotStatus', () => {
  it.each([
    ['monitoring', true, 'working'],
    ['working', true, 'working'],
    ['permission', true, 'permission'],
    ['done', false, 'active'],
    ['done', true, 'inactive']
  ] as const)('maps %s with paused=%s to %s', (status, paused, folded) => {
    expect(foldBotStatus(status, paused)).toBe(folded)
  })
})
