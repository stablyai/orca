import { describe, expect, it } from 'vitest'
import { pickNextActiveTab, pickTabCloseSuccessor } from './tab-close-successor'
import type { TabGroup } from './tab-types'

describe('pickNextActiveTab', () => {
  it('returns the most-recent non-closing id', () => {
    expect(pickNextActiveTab(['a', 'b', 'c'], ['a', 'c', 'b'], 'b')).toBe('c')
  })

  it('skips the closing id if it appears in MRU', () => {
    expect(pickNextActiveTab(['a', 'b', 'c'], ['a', 'b', 'c'], 'c')).toBe('b')
  })

  it('falls back to visual neighbor when MRU is empty or has only the closing id', () => {
    expect(pickNextActiveTab(['a', 'b', 'c'], [], 'b')).toBe('c')
    expect(pickNextActiveTab(['a', 'b', 'c'], ['b'], 'b')).toBe('c')
  })

  it('falls back to left neighbor when closing the rightmost and MRU is empty', () => {
    expect(pickNextActiveTab(['a', 'b', 'c'], undefined, 'c')).toBe('b')
  })
})

describe('pickTabCloseSuccessor', () => {
  it('reveals the only hidden survivor even when a legacy order repeats the closing id', () => {
    const group: Pick<TabGroup, 'activeTabId' | 'recentTabIds' | 'tabClusters'> = {
      activeTabId: 'a',
      recentTabIds: [],
      tabClusters: [{ id: 'c', name: '', color: 'blue', collapsed: true, tabIds: ['a', 'b'] }]
    }
    expect(pickTabCloseSuccessor(group, ['a', 'a', 'b'], 'a')).toBe('b')
  })
})
