import { describe, expect, it } from 'vitest'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import { countActivityUnread } from './useActivityUnreadCount'

const PANE = 'tab-1:11111111-1111-4111-8111-111111111111'

function makeEntry(overrides: Partial<AgentStatusEntry>): AgentStatusEntry {
  return {
    state: 'done',
    prompt: '',
    updatedAt: 2_000,
    stateStartedAt: 2_000,
    paneKey: PANE,
    agentType: 'claude',
    stateHistory: [],
    ...overrides
  }
}

function makeSource(entry: AgentStatusEntry, ackAt = 0) {
  return {
    acknowledgedAgentsByPaneKey: { [PANE]: ackAt },
    agentStatusByPaneKey: { [PANE]: entry },
    migrationUnsupportedByPtyId: {},
    retainedAgentsByPaneKey: {}
  }
}

describe('countActivityUnread session-boundary rows (STA-3386)', () => {
  it('does not count a session-boundary done as unread', () => {
    const source = makeSource(makeEntry({ sessionBoundary: true }))
    expect(countActivityUnread(source)).toBe(0)
  })

  it('keeps counting a real completion displaced into history by a session boundary', () => {
    // Why: agent finished (unacknowledged), then the user resumed the session — the
    // boundary row replaces the live done but the finish must stay unread.
    const source = makeSource(
      makeEntry({
        sessionBoundary: true,
        stateHistory: [{ state: 'done', prompt: 'fix bug', startedAt: 1_000 }]
      })
    )
    expect(countActivityUnread(source)).toBe(1)
  })

  it('stops counting the displaced completion once acknowledged', () => {
    const source = makeSource(
      makeEntry({
        sessionBoundary: true,
        stateHistory: [{ state: 'done', prompt: 'fix bug', startedAt: 1_000 }]
      }),
      1_500
    )
    expect(countActivityUnread(source)).toBe(0)
  })

  it('still counts an ordinary unacknowledged done', () => {
    const source = makeSource(makeEntry({}))
    expect(countActivityUnread(source)).toBe(1)
  })
})

describe('countActivityUnread with Clear completed cutoffs', () => {
  it('does not count events hidden by the pane cutoff', () => {
    const source = {
      ...makeSource(
        makeEntry({
          stateHistory: [{ state: 'done', prompt: 'older run', startedAt: 1_000 }]
        })
      ),
      activityClearedAtByPaneKey: { [PANE]: 2_000 }
    }
    // Both the history event (1_000) and the live done (2_000) are at or before the cutoff.
    expect(countActivityUnread(source)).toBe(0)
  })

  it('keeps counting turns newer than the cutoff', () => {
    const source = {
      ...makeSource(
        makeEntry({
          stateStartedAt: 3_000,
          stateHistory: [{ state: 'done', prompt: 'older run', startedAt: 1_000 }]
        })
      ),
      activityClearedAtByPaneKey: { [PANE]: 2_000 }
    }
    expect(countActivityUnread(source)).toBe(1)
  })
})

describe('countActivityUnread source overlap', () => {
  it('counts an overlapping live and retained pane only once', () => {
    const entry = makeEntry({})
    const source = {
      acknowledgedAgentsByPaneKey: { [PANE]: 0 },
      agentStatusByPaneKey: { [PANE]: entry },
      retainedAgentsByPaneKey: {
        [PANE]: {
          entry,
          worktreeId: 'wt-1',
          tab: {} as never,
          agentType: 'claude',
          startedAt: 1_000
        }
      },
      migrationUnsupportedByPtyId: {}
    }
    expect(countActivityUnread(source)).toBe(1)
  })
})
