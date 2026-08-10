import { describe, expect, it } from 'vitest'
import type { Space } from '../../../shared/types'
import { getAdjacentSpace, getIndexedSpace } from './space-shortcut-navigation'

const SPACES: Space[] = ['default', 'work', 'personal'].map((id, index) => ({
  id,
  name: id,
  emoji: null,
  createdAt: index,
  updatedAt: index
}))

describe('space shortcut navigation', () => {
  it('selects a Space by zero-based index and rejects out-of-range ones', () => {
    expect(getIndexedSpace(SPACES, 1)?.id).toBe('work')
    expect(getIndexedSpace(SPACES, 9)).toBeNull()
  })

  it('moves between adjacent Spaces', () => {
    expect(getAdjacentSpace(SPACES, 'work', 'previous')?.id).toBe('default')
    expect(getAdjacentSpace(SPACES, 'work', 'next')?.id).toBe('personal')
  })

  it('wraps past either end so the shortcuts match the pager loop', () => {
    expect(getAdjacentSpace(SPACES, 'personal', 'next')?.id).toBe('default')
    expect(getAdjacentSpace(SPACES, 'default', 'previous')?.id).toBe('personal')
  })

  it('has nowhere to wrap with a single Space', () => {
    expect(getAdjacentSpace(SPACES.slice(0, 1), 'default', 'next')).toBeNull()
    expect(getAdjacentSpace(SPACES.slice(0, 1), 'default', 'previous')).toBeNull()
  })
})
