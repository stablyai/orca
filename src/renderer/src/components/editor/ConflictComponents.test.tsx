import { describe, expect, it } from 'vitest'
import { getNextConflictNavigationIndex } from './ConflictComponents'

describe('getNextConflictNavigationIndex', () => {
  it('cycles through conflicts in both directions', () => {
    expect(
      getNextConflictNavigationIndex({ currentIndex: null, direction: 'next', total: 3 })
    ).toBe(0)
    expect(getNextConflictNavigationIndex({ currentIndex: 2, direction: 'next', total: 3 })).toBe(0)
    expect(
      getNextConflictNavigationIndex({ currentIndex: 0, direction: 'previous', total: 3 })
    ).toBe(2)
    expect(
      getNextConflictNavigationIndex({ currentIndex: null, direction: 'previous', total: 3 })
    ).toBe(2)
    expect(getNextConflictNavigationIndex({ currentIndex: 0, direction: 'next', total: 0 })).toBe(
      null
    )
  })
})
