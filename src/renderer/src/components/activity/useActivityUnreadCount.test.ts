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
    retainedAgentsByPaneKey: {},
    worktreesByRepo: {}
  }
}

describe('countActivityUnread session-boundary rows (STA-3386)', () => {
  it('does not count a session-boundary done as unread in either mode', () => {
    const source = makeSource(makeEntry({ sessionBoundary: true }))
    expect(countActivityUnread(source, 'sidebar-badge')).toBe(0)
    expect(countActivityUnread(source, 'agent-events')).toBe(0)
  })

  it('keeps counting a real completion displaced into history by a session boundary', () => {
    // Why: agent finished (unacknowledged), then the user resumed the session — the
    // boundary row replaces the live done but the finish must stay unread in both badges.
    const source = makeSource(
      makeEntry({
        sessionBoundary: true,
        stateHistory: [{ state: 'done', prompt: 'fix bug', startedAt: 1_000 }]
      })
    )
    expect(countActivityUnread(source, 'sidebar-badge')).toBe(1)
    expect(countActivityUnread(source, 'agent-events')).toBe(1)
  })

  it('stops counting the displaced completion once acknowledged', () => {
    const source = makeSource(
      makeEntry({
        sessionBoundary: true,
        stateHistory: [{ state: 'done', prompt: 'fix bug', startedAt: 1_000 }]
      }),
      1_500
    )
    expect(countActivityUnread(source, 'sidebar-badge')).toBe(0)
    expect(countActivityUnread(source, 'agent-events')).toBe(0)
  })

  it('still counts an ordinary unacknowledged done in sidebar-badge mode', () => {
    const source = makeSource(makeEntry({}))
    expect(countActivityUnread(source, 'sidebar-badge')).toBe(1)
  })
})
