import { expect, it } from 'vitest'
import { activityThreadRowCopy } from './activity-thread-presentation'
import {
  makeRepo,
  makeTab,
  makeWorktree,
  makeWorkingEntryWithoutHistory,
  PANE_KEY
} from './ActivityPrototypePage-test-fixtures'
import type { AgentPaneThread } from './activity-thread-types'

it('shows the unknown state instead of a stale preview', () => {
  const entry = { ...makeWorkingEntryWithoutHistory(), workingMode: 'monitoring' as const }
  const thread: AgentPaneThread = {
    paneKey: PANE_KEY,
    paneTitle: 'Background task',
    worktree: makeWorktree(),
    repo: makeRepo(),
    tab: makeTab(),
    agentType: 'claude',
    currentAgentState: 'unverifiable',
    currentAgentEntry: entry,
    responsePreview: 'Earlier assistant response',
    latestTimestamp: 3_000,
    latestEvent: null,
    events: [],
    unread: false
  }

  expect(activityThreadRowCopy(thread).statusKind).toBe('state')
  expect(activityThreadRowCopy({ ...thread, currentAgentState: 'monitoring' }).statusKind).toBe(
    'message'
  )
})
