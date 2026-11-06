import { describe, expect, it } from 'vitest'

import { activityThreadMatchesSearchQuery } from './activity-thread-grouping'

import type { AgentPaneThread } from './activity-thread-types'
import { makeWorktree, makeTab } from './ActivityPrototypePage-test-fixtures'

{
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

  describe('activity thread search', () => {
    it('searches rebuilt thread data when the pane key stays the same', () => {
      const first = makeThread('tab-1:leaf-1', 'First title')
      const rebuilt = makeThread('tab-1:leaf-1', 'Second title')
      expect(activityThreadMatchesSearchQuery({ thread: first, searchQuery: 'first' })).toBe(true)
      expect(activityThreadMatchesSearchQuery({ thread: rebuilt, searchQuery: 'second' })).toBe(
        true
      )
      expect(activityThreadMatchesSearchQuery({ thread: rebuilt, searchQuery: 'first' })).toBe(
        false
      )
    })
  })
}
