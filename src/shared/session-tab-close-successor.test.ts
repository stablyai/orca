import { describe, expect, it } from 'vitest'
import {
  collectRecentTabIdsFromGroups,
  pickNextTabAfterClose,
  pickNextTabIdAfterClose,
  rememberRecentTabId
} from './session-tab-close-successor'

describe('rememberRecentTabId', () => {
  it('appends a newly viewed tab and moves repeats to the tail', () => {
    expect(rememberRecentTabId(['a', 'b'], 'c')).toEqual(['a', 'b', 'c'])
    expect(rememberRecentTabId(['a', 'b', 'c'], 'a')).toEqual(['b', 'c', 'a'])
    expect(rememberRecentTabId(['a', 'b'], 'b')).toEqual(['a', 'b'])
  })
})

describe('pickNextTabIdAfterClose', () => {
  it('returns the previously viewed remaining tab', () => {
    expect(
      pickNextTabIdAfterClose({
        remainingTabIds: ['term', 'doc-a'],
        closingTabId: 'doc-b',
        recentTabIds: ['term', 'doc-a', 'doc-b']
      })
    ).toBe('doc-a')
  })

  it('falls back to the most recently added remaining tab when there is no previous visit', () => {
    expect(
      pickNextTabIdAfterClose({
        remainingTabIds: ['term', 'doc-a'],
        closingTabId: 'doc-b',
        recentTabIds: ['doc-b']
      })
    ).toBe('doc-a')
    expect(
      pickNextTabIdAfterClose({
        remainingTabIds: ['term', 'doc-a'],
        closingTabId: 'doc-b'
      })
    ).toBe('doc-a')
  })

  it('does not default to the leftmost remaining tab when a previous visit exists', () => {
    expect(
      pickNextTabIdAfterClose({
        remainingTabIds: ['leftmost', 'middle', 'right'],
        closingTabId: 'current',
        recentTabIds: ['leftmost', 'middle', 'current']
      })
    ).toBe('middle')
  })
})

describe('pickNextTabAfterClose', () => {
  it('returns the matching remaining tab object', () => {
    const remaining = [{ id: 'a' }, { id: 'b' }]
    expect(pickNextTabAfterClose(remaining, 'c', ['a', 'c'])).toEqual({ id: 'a' })
    expect(pickNextTabAfterClose(remaining, 'c', [])).toEqual({ id: 'b' })
  })

  it('selects by a top-level id and returns the matching leaf tab', () => {
    const remaining = [
      { id: 'parent-b::left', parentTabId: 'parent-b' },
      { id: 'parent-c::left', parentTabId: 'parent-c' }
    ]
    expect(
      pickNextTabAfterClose(
        remaining,
        'parent-a',
        ['parent-c', 'parent-b'],
        (tab) => tab.parentTabId
      )
    ).toEqual(remaining[0])
  })
})

describe('collectRecentTabIdsFromGroups', () => {
  it('merges group MRU stacks in visit order', () => {
    expect(
      collectRecentTabIdsFromGroups([{ recentTabIds: ['a', 'b'] }, { recentTabIds: ['c', 'a'] }])
    ).toEqual(['b', 'c', 'a'])
  })
})
