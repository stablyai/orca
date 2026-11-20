import { expect, it } from 'vitest'
import { botItemWalkReturnRow } from './bot-item-walk'

it('returns Back to the item’s row, else the nearest listed one after it, then before, then the last', () => {
  const walk = { uids: ['a', 'b', 'c', 'd'], total: 4 }
  expect(botItemWalkReturnRow(walk, 'b', ['a', 'b', 'd'])).toBe('b')
  expect(botItemWalkReturnRow(walk, 'b', ['a', 'd'])).toBe('d')
  expect(botItemWalkReturnRow(walk, 'd', ['a', 'b'])).toBe('b')
  expect(botItemWalkReturnRow(null, 'z', ['a', 'x'])).toBe('x')
  expect(botItemWalkReturnRow(walk, 'b', [])).toBeNull()
})
