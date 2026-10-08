import { describe, expect, it } from 'vitest'
import type { AgentTurnOutcome } from '../../../../shared/agent-turn-outcome'
import type { ActivityEvent, AgentPaneThread } from './activity-thread-types'
import { activityThreadRowCopy, agentMeta, agentTitle } from './activity-thread-presentation'
import { formatShortTimeAgo } from '@/lib/short-time-ago'
import {
  makeRepo,
  makeTab,
  makeTabWithIds,
  makeWorkingEntryWithoutHistory,
  makeWorktree,
  PANE_KEY
} from './ActivityPrototypePage-test-fixtures'

function makeThread(overrides: Partial<AgentPaneThread> = {}): AgentPaneThread {
  const worktree = makeWorktree()
  return {
    paneKey: PANE_KEY,
    paneTitle: 'low hanging issues',
    agentType: 'codex',
    worktree,
    repo: makeRepo(),
    tab: makeTabWithIds('tab-1', worktree.id),
    events: [],
    latestEvent: null,
    latestTimestamp: 1_000,
    currentAgentState: null,
    currentAgentEntry: null,
    unread: false,
    responsePreview: '',
    ...overrides
  }
}

describe('formatShortTimeAgo', () => {
  it('uses short units', () => {
    const now = 1_000_000
    expect(formatShortTimeAgo(now - 10_000, now)).toBe('now')
    expect(formatShortTimeAgo(now - 5 * 60_000, now)).toBe('5m')
    expect(formatShortTimeAgo(now - 20 * 60 * 60_000, now)).toBe('20h')
    expect(formatShortTimeAgo(now - 2 * 24 * 60 * 60_000, now)).toBe('2d')
  })
})

describe('activityThreadRowCopy', () => {
  it('leads with the task and the last activity, not project or workspace', () => {
    const copy = activityThreadRowCopy(
      makeThread({
        responsePreview: 'Filed 8 issues from the audit.'
      })
    )
    expect(copy.taskTitle).toBe('low hanging issues')
    expect(copy.statusLine).toBe('Filed 8 issues from the audit.')
    expect(copy.statusKind).toBe('message')
    expect(copy.needsAttention).toBe(false)
    expect(copy.workspaceLabel).toBe('feature')
  })

  it('names the live tool while working', () => {
    const copy = activityThreadRowCopy(
      makeThread({
        paneTitle: 'Fix checkout race',
        currentAgentState: 'working',
        responsePreview: 'Edit src/checkout/session.ts'
      })
    )
    expect(copy.statusKind).toBe('tool')
    expect(copy.statusLine).toBe('Edit src/checkout/session.ts')
  })

  it('falls back to a state label when a live agent has no preview', () => {
    const copy = activityThreadRowCopy(
      makeThread({
        paneTitle: 'Review PR 1842',
        currentAgentState: 'waiting',
        responsePreview: ''
      })
    )
    expect(copy.statusKind).toBe('state')
    expect(copy.statusLine).toBe('Waiting for input')
    expect(copy.needsAttention).toBe(true)
  })

  it('does not invent a status line for a finished agent with no reply', () => {
    const copy = activityThreadRowCopy(makeThread({ currentAgentState: null, responsePreview: '' }))
    expect(copy.statusKind).toBe('none')
    expect(copy.statusLine).toBe('')
  })

  it('does not repeat the task title as the last-message line', () => {
    const copy = activityThreadRowCopy(
      makeThread({
        paneTitle: 'low hanging issues',
        responsePreview: 'low hanging issues'
      })
    )
    expect(copy.statusKind).toBe('none')
    expect(copy.statusLine).toBe('')
  })
})

describe('agentTitle and agentMeta for a finished turn', () => {
  function doneEvent(outcome: AgentTurnOutcome): ActivityEvent {
    return {
      id: 'event-1',
      state: 'done',
      timestamp: 3_000,
      observedAt: 3_000,
      worktree: makeWorktree(),
      repo: makeRepo(),
      entry: {
        ...makeWorkingEntryWithoutHistory(),
        state: 'done',
        mainAgent: { state: 'done', outcome, stateStartedAt: 3_000 }
      },
      tab: makeTab(),
      agentType: 'claude',
      agentAlive: false,
      unread: false
    }
  }

  // A crash, quit or restart cut reads as the interruption it is, as a Stop does; only a failure fails.
  it.each([
    ['cancellation', 'Agent interrupted', 'Claude interrupted'],
    ['interruption', 'Agent interrupted', 'Claude interrupted'],
    ['failure', 'Agent failed', 'Claude failed']
  ] as const)('titles a %s as %s', (outcome, title, meta) => {
    expect(agentTitle(doneEvent(outcome))).toBe(title)
    expect(agentMeta(doneEvent(outcome))).toBe(meta)
  })
})
