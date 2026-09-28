import { describe, expect, it } from 'vitest'
import {
  AGENT_STATUS_STALE_AFTER_MS,
  type AgentStatusEntry
} from '../../../../shared/agent-status-types'
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

describe('countActivityUnread working turns', () => {
  it('counts fresh working, but not monitoring, historical, or retained working', () => {
    const entry = makeEntry({
      state: 'working',
      stateHistory: [{ state: 'working', prompt: 'old', startedAt: 1_000 }]
    })
    expect(countActivityUnread(makeSource(entry), 2_000)).toBe(1)
    // Monitoring emits no unread event in the list (4b2e3dded0), so the badge must not count it.
    expect(countActivityUnread(makeSource({ ...entry, workingMode: 'monitoring' }), 2_000)).toBe(0)
    expect(
      countActivityUnread(
        {
          ...makeSource(entry),
          agentStatusByPaneKey: {},
          retainedAgentsByPaneKey: {
            [PANE]: {
              entry,
              worktreeId: 'wt-1',
              tab: {} as never,
              agentType: 'claude',
              startedAt: 1_000
            }
          }
        },
        2_000
      )
    ).toBe(0)
  })

  it('preserves receipts across heartbeats and counts the next turn', () => {
    const entry = makeEntry({ state: 'working', updatedAt: 3_000 })
    expect(countActivityUnread(makeSource(entry, 2_000), 3_000)).toBe(0)
    expect(countActivityUnread(makeSource({ ...entry, stateStartedAt: 3_000 }, 2_000), 3_000)).toBe(
      1
    )
    expect(
      countActivityUnread(
        { ...makeSource(entry), activityClearedAtByPaneKey: { [PANE]: 2_000 } },
        3_000
      )
    ).toBe(0)
  })

  it('drops stale or unconfirmed working and revives only on fresh evidence', () => {
    const entry = makeEntry({ state: 'working' })
    expect(countActivityUnread(makeSource(entry), 2_000 + AGENT_STATUS_STALE_AFTER_MS)).toBe(1)
    const expiredAt = 2_001 + AGENT_STATUS_STALE_AFTER_MS
    expect(countActivityUnread(makeSource(entry), expiredAt)).toBe(0)
    expect(countActivityUnread(makeSource({ ...entry, updatedAt: expiredAt }), expiredAt)).toBe(1)
    expect(countActivityUnread(makeSource({ ...entry, restoredUnconfirmed: true }), 2_000)).toBe(0)
  })
})

describe('countActivityUnread reads the combined state, not the main agent fact', () => {
  // The badge mirrors the Activity feed, which builds its rows from the combined state: a settled
  // main agent whose subagent still runs is one live working row there, and no done event exists for
  // the main agent's own finish until the row itself settles.
  const NOW = AGENT_STATUS_STALE_AFTER_MS

  it('counts a fresh row held working by a subagent as one live working turn', () => {
    const source = makeSource(
      makeEntry({
        state: 'working',
        updatedAt: NOW - 1_000,
        stateStartedAt: NOW - 5_000,
        mainAgent: { state: 'done', stateStartedAt: NOW - 2_000 }
      })
    )
    expect(countActivityUnread(source, NOW)).toBe(1)
  })

  it('does not count a settled main agent with only a watch loop, matching the feed', () => {
    const source = makeSource(
      makeEntry({
        state: 'working',
        workingMode: 'monitoring',
        updatedAt: NOW - 1_000,
        stateStartedAt: NOW - 5_000,
        mainAgent: { state: 'done', stateStartedAt: NOW - 2_000 }
      })
    )
    expect(countActivityUnread(source, NOW)).toBe(0)
  })

  it('does not count a restored row as a live turn, whatever its main agent says', () => {
    const source = makeSource(
      makeEntry({
        state: 'working',
        updatedAt: NOW - 1_000,
        stateStartedAt: NOW - 5_000,
        restoredUnconfirmed: true,
        mainAgent: { state: 'working', stateStartedAt: NOW - 5_000 }
      })
    )
    expect(countActivityUnread(source, NOW)).toBe(0)
  })
})
