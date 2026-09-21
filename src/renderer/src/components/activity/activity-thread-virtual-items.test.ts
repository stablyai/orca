import { describe, expect, it } from 'vitest'
import {
  buildActivityVirtualItems,
  findActivityThreadItemIndex,
  getActivityHeaderItemIndexes,
  getActivityVirtualItemKey
} from './activity-thread-virtual-items'
import type { ActivityThreadGroup, AgentPaneThread } from './activity-thread-types'
import { makeTab, makeWorktree } from './ActivityPrototypePage-test-fixtures'

function makeThread(paneKey: string): AgentPaneThread {
  return {
    paneKey,
    tab: makeTab(),
    worktree: makeWorktree(),
    repo: null,
    currentAgentState: null,
    currentAgentEntry: null,
    latestEvent: null,
    latestTimestamp: 1000,
    agentType: 'claude',
    unread: false,
    paneTitle: `Agent ${paneKey}`,
    responsePreview: '',
    events: []
  }
}

function makeGroup(key: string, threadKeys: string[]): ActivityThreadGroup {
  return { key, label: key, threads: threadKeys.map(makeThread) }
}

describe('buildActivityVirtualItems', () => {
  it('flattens headers and threads in group order', () => {
    const items = buildActivityVirtualItems({
      groups: [makeGroup('working', ['a', 'b']), makeGroup('done', ['c'])],
      groupBy: 'status',
      collapsedGroupKeys: new Set()
    })
    expect(items.map((item) => getActivityVirtualItemKey(item))).toEqual([
      'h:working',
      't:a',
      't:b',
      'h:done',
      't:c'
    ])
    expect(getActivityHeaderItemIndexes(items)).toEqual([0, 3])
  })

  it('omits header rows entirely when ungrouped', () => {
    const items = buildActivityVirtualItems({
      groups: [{ key: 'all', label: '', threads: [makeThread('a'), makeThread('b')] }],
      groupBy: 'none',
      collapsedGroupKeys: new Set()
    })
    expect(items.map((item) => getActivityVirtualItemKey(item))).toEqual(['t:a', 't:b'])
  })

  it('keeps a collapsed group header but drops its thread rows', () => {
    const items = buildActivityVirtualItems({
      groups: [makeGroup('working', ['a', 'b']), makeGroup('done', ['c'])],
      groupBy: 'status',
      collapsedGroupKeys: new Set(['working'])
    })
    expect(items.map((item) => getActivityVirtualItemKey(item))).toEqual([
      'h:working',
      'h:done',
      't:c'
    ])
  })

  it('locates the selected thread row by paneKey', () => {
    const items = buildActivityVirtualItems({
      groups: [makeGroup('working', ['a', 'b', 'c'])],
      groupBy: 'status',
      collapsedGroupKeys: new Set()
    })
    expect(findActivityThreadItemIndex(items, 'c')).toBe(3)
    expect(findActivityThreadItemIndex(items, 'missing')).toBeNull()
    expect(findActivityThreadItemIndex(items, null)).toBeNull()
  })
})
