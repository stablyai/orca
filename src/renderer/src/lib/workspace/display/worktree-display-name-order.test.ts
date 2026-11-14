import { expect, it } from 'vitest'
import { compareDisplayName } from './worktree-display-name-order'

it('orders absent workspace names as empty names', () => {
  expect(compareDisplayName(undefined, 'Beta')).toBeLessThan(0)
  expect(compareDisplayName('Beta', null)).toBeGreaterThan(0)
  expect(compareDisplayName(undefined, null)).toBe(0)
})
