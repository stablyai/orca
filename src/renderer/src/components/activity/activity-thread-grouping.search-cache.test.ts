import { describe, expect, it } from 'vitest'
import {
  activityThreadMatchesSearchQuery,
  getThreadSearchTextComputeCount
} from './activity-thread-grouping'
import type { AgentPaneThread } from './activity-thread-types'
import { makeTab, makeWorktree } from './ActivityPrototypePage-test-fixtures'

function makeThread(paneKey: string, paneTitle: string): AgentPaneThread {
  return {
    paneKey,
    tab: makeTab(),
    worktree: makeWorktree(),
    repo: null,
    currentAgentState: null,
    currentAgentEntry: null,
    latestEvent: null,
    latestTimestamp: 1_000,
    agentType: 'claude',
    unread: false,
    paneTitle,
    responsePreview: 'x'.repeat(2_000),
    events: []
  }
}

describe('activity thread search text cache', () => {
  it('builds a thread searchable text once per thread identity across keystrokes', () => {
    const thread = makeThread('tab-1:leaf-1', 'Refactor billing pipeline')
    const before = getThreadSearchTextComputeCount()
    // Simulate typing a query letter by letter against the same thread objects.
    for (const searchQuery of ['r', 're', 'ref', 'refa', 'refac']) {
      expect(activityThreadMatchesSearchQuery({ thread, searchQuery })).toBe(true)
    }
    expect(getThreadSearchTextComputeCount() - before).toBe(1)
  })

  it('recomputes when thread data changes (new thread identity)', () => {
    const before = getThreadSearchTextComputeCount()
    const first = makeThread('tab-1:leaf-1', 'First title')
    const rebuilt = makeThread('tab-1:leaf-1', 'Second title')
    expect(activityThreadMatchesSearchQuery({ thread: first, searchQuery: 'first' })).toBe(true)
    expect(activityThreadMatchesSearchQuery({ thread: rebuilt, searchQuery: 'second' })).toBe(true)
    expect(getThreadSearchTextComputeCount() - before).toBe(2)
  })

  it('keeps match semantics: state labels, workspace, and previews still match', () => {
    const thread = makeThread('tab-1:leaf-1', 'My task')
    expect(activityThreadMatchesSearchQuery({ thread, searchQuery: 'feature' })).toBe(true)
    expect(activityThreadMatchesSearchQuery({ thread, searchQuery: 'zzz-no-match' })).toBe(false)
    expect(activityThreadMatchesSearchQuery({ thread, searchQuery: '' })).toBe(true)
  })
})
