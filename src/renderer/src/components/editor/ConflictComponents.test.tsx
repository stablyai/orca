import { describe, expect, it } from 'vitest'
import {
  getConflictHint,
  getConflictKindLabel,
  getConflictStatusLabel,
  getNextConflictNavigationIndex
} from './ConflictComponents'

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

describe('localized conflict copy', () => {
  it('resolves every conflict kind to its own label and hint', () => {
    expect(getConflictKindLabel('both_modified')).toBe('Both modified')
    expect(getConflictKindLabel('both_added')).toBe('Both added')
    expect(getConflictKindLabel('deleted_by_us')).toBe('Deleted by us')
    expect(getConflictKindLabel('deleted_by_them')).toBe('Deleted by them')
    expect(getConflictKindLabel('added_by_us')).toBe('Added by us')
    expect(getConflictKindLabel('added_by_them')).toBe('Added by them')
    expect(getConflictKindLabel('both_deleted')).toBe('Both deleted')

    expect(getConflictHint('both_modified')).toBe('Resolve the conflict markers')
    expect(getConflictHint('both_added')).toBe('Choose which version to keep, or combine them')
    expect(getConflictHint('deleted_by_us')).toBe('Decide whether to restore the file')
    expect(getConflictHint('deleted_by_them')).toBe(
      'Decide whether to keep the file or accept deletion'
    )
    expect(getConflictHint('added_by_us')).toBe('Review whether to keep the added file')
    expect(getConflictHint('added_by_them')).toBe('Review the added file before keeping it')
    expect(getConflictHint('both_deleted')).toBe(
      'Resolve in Git or restore one side before editing'
    )
  })

  it('keeps unresolved and locally resolved states as separate translation units', () => {
    expect(getConflictStatusLabel(true)).toBe('Unresolved')
    expect(getConflictStatusLabel(false)).toBe('Resolved locally')
  })
})
