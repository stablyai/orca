import { describe, expect, it } from 'vitest'
import {
  assignCollectionMembership,
  clampExclusiveCollectionMembership,
  getNextCollectionOrder,
  normalizeCollections
} from './collections'
import type { Collection } from './collection-types'

function makeCollection(id: string, name: string, order: number): Collection {
  return { id, name, color: null, isCollapsed: false, order, createdAt: 1, updatedAt: 1 }
}

describe('normalizeCollections', () => {
  it('drops garbage entries, dedupes ids, and fills defaults', () => {
    const normalized = normalizeCollections([
      null,
      'nope',
      { id: '' },
      { id: 'c1', name: 'One', order: 1, createdAt: 1, updatedAt: 1 },
      { id: 'c1', name: 'Duplicate' },
      { id: 'c2', name: 7, color: 3, order: Number.NaN, isCollapsed: 'yes' }
    ])
    expect(normalized.map((collection) => collection.id)).toEqual(['c2', 'c1'])
    const c2 = normalized[0]
    expect(c2).toMatchObject({
      name: 'Untitled collection',
      color: null,
      isCollapsed: false,
      order: 0
    })
  })

  it('sorts by order then name', () => {
    const normalized = normalizeCollections([
      makeCollection('b', 'Beta', 1),
      makeCollection('a', 'Alpha', 1),
      makeCollection('z', 'Zulu', 0)
    ])
    expect(normalized.map((collection) => collection.id)).toEqual(['z', 'a', 'b'])
  })
})

describe('getNextCollectionOrder', () => {
  it('keeps appending after a middle delete', () => {
    // a(0) b(1) c(2) with b deleted → next is still 3, not 2.
    expect(getNextCollectionOrder([makeCollection('a', 'A', 0), makeCollection('c', 'C', 2)])).toBe(
      3
    )
  })
})

describe('assignCollectionMembership', () => {
  it('exclusive replaces every existing membership (move semantics)', () => {
    expect(assignCollectionMembership(['c1', 'c2'], 'c3', { exclusive: true })).toEqual(['c3'])
    expect(assignCollectionMembership(undefined, 'c1', { exclusive: true })).toEqual(['c1'])
  })

  it('non-exclusive appends and stays idempotent (main worktrees)', () => {
    expect(assignCollectionMembership(['c1'], 'c2', { exclusive: false })).toEqual(['c1', 'c2'])
    expect(assignCollectionMembership(['c1'], 'c1', { exclusive: false })).toEqual(['c1'])
  })
})

describe('clampExclusiveCollectionMembership', () => {
  it('keeps only the most recent membership for feature worktrees', () => {
    expect(clampExclusiveCollectionMembership(['c1', 'c2', 'c3'], false)).toEqual(['c3'])
  })

  it('preserves multi-membership for main worktrees', () => {
    expect(clampExclusiveCollectionMembership(['c1', 'c2'], true)).toEqual(['c1', 'c2'])
  })

  it('passes empty and single memberships through untouched (blanking contract)', () => {
    expect(clampExclusiveCollectionMembership([], false)).toEqual([])
    expect(clampExclusiveCollectionMembership(['c1'], false)).toEqual(['c1'])
  })
})
