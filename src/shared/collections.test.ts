import { describe, expect, it } from 'vitest'
import {
  addCollectionId,
  assignCollectionMembership,
  clampExclusiveCollectionMembership,
  createCollection,
  getNextCollectionOrder,
  isInCollection,
  normalizeCollectionIds,
  normalizeCollectionName,
  normalizeCollections,
  pruneMissingCollectionIds,
  removeCollectionId,
  sortCollectionsByOrder
} from './collections'
import type { Collection } from './collection-types'

function makeCollection(id: string, name: string, order: number): Collection {
  return { id, name, color: null, isCollapsed: false, order, createdAt: 1, updatedAt: 1 }
}

describe('createCollection', () => {
  it('trims the name and falls back when blank', () => {
    expect(createCollection({ name: '  Approve PRs ', order: 0, now: 5 }).name).toBe('Approve PRs')
    expect(createCollection({ name: '   ', order: 0, now: 5 }).name).toBe('Untitled collection')
  })

  it('seeds defaults and stamps both timestamps from now', () => {
    const collection = createCollection({ name: 'Billing', order: 3, now: 42 })
    expect(collection).toMatchObject({
      color: null,
      isCollapsed: false,
      order: 3,
      createdAt: 42,
      updatedAt: 42
    })
    expect(collection.id.length).toBeGreaterThan(0)
  })

  it('mints unique ids', () => {
    const first = createCollection({ name: 'a', order: 0, now: 1 })
    const second = createCollection({ name: 'a', order: 0, now: 1 })
    expect(first.id).not.toBe(second.id)
  })
})

describe('normalizeCollectionName', () => {
  it('honors a custom fallback', () => {
    expect(normalizeCollectionName('', 'X')).toBe('X')
  })
})

describe('normalizeCollections', () => {
  it('returns [] for non-arrays', () => {
    expect(normalizeCollections(undefined)).toEqual([])
    expect(normalizeCollections({})).toEqual([])
  })

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

describe('sortCollectionsByOrder', () => {
  it('does not mutate its input', () => {
    const input = [makeCollection('b', 'B', 2), makeCollection('a', 'A', 1)]
    const sorted = sortCollectionsByOrder(input)
    expect(sorted.map((collection) => collection.id)).toEqual(['a', 'b'])
    expect(input.map((collection) => collection.id)).toEqual(['b', 'a'])
  })
})

describe('getNextCollectionOrder', () => {
  it('starts at 0 and appends after the max', () => {
    expect(getNextCollectionOrder([])).toBe(0)
    expect(getNextCollectionOrder([makeCollection('a', 'A', 0), makeCollection('b', 'B', 4)])).toBe(
      5
    )
  })

  it('keeps appending after a middle delete', () => {
    // a(0) b(1) c(2) with b deleted → next is still 3, not 2.
    expect(getNextCollectionOrder([makeCollection('a', 'A', 0), makeCollection('c', 'C', 2)])).toBe(
      3
    )
  })
})

describe('normalizeCollectionIds', () => {
  it('returns undefined for non-arrays and empty results', () => {
    expect(normalizeCollectionIds(undefined)).toBeUndefined()
    expect(normalizeCollectionIds('c1')).toBeUndefined()
    expect(normalizeCollectionIds([])).toBeUndefined()
    expect(normalizeCollectionIds([3, '', null])).toBeUndefined()
  })

  it('dedupes while preserving first-seen order', () => {
    expect(normalizeCollectionIds(['c2', 'c1', 'c2', 'c1'])).toEqual(['c2', 'c1'])
  })
})

describe('membership add/remove', () => {
  it('adds from undefined and is idempotent', () => {
    expect(addCollectionId(undefined, 'c1')).toEqual(['c1'])
    expect(addCollectionId(['c1'], 'c1')).toEqual(['c1'])
    expect(addCollectionId(['c1'], 'c2')).toEqual(['c1', 'c2'])
  })

  it('supports the same worktree living in several collections', () => {
    const ids = addCollectionId(addCollectionId(undefined, 'approve-prs'), 'billing')
    expect(isInCollection(ids, 'approve-prs')).toBe(true)
    expect(isInCollection(ids, 'billing')).toBe(true)
  })

  it('removing the last membership yields undefined, never []', () => {
    expect(removeCollectionId(['c1'], 'c1')).toBeUndefined()
    expect(removeCollectionId(['c1', 'c2'], 'c1')).toEqual(['c2'])
    expect(removeCollectionId(undefined, 'c1')).toBeUndefined()
  })

  it('removing an absent id keeps the rest intact', () => {
    expect(removeCollectionId(['c1', 'c2'], 'c3')).toEqual(['c1', 'c2'])
  })

  it('isInCollection handles undefined', () => {
    expect(isInCollection(undefined, 'c1')).toBe(false)
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

describe('pruneMissingCollectionIds', () => {
  it('drops dangling ids and collapses to undefined when none survive', () => {
    const existing = new Set(['c1'])
    expect(pruneMissingCollectionIds(['c1', 'gone'], existing)).toEqual(['c1'])
    expect(pruneMissingCollectionIds(['gone'], existing)).toBeUndefined()
    expect(pruneMissingCollectionIds(undefined, existing)).toBeUndefined()
  })
})
