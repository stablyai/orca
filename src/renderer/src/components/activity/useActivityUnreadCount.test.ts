import { describe, expect, it } from 'vitest'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import type { TerminalTab } from '../../../../shared/types'
import type { RetainedAgentEntry } from '@/store/slices/agent-status'
import { countUnreadAgentPaneThreads } from './agent-pane-threads'

const PANE = makePaneKey('tab-1', '11111111-1111-4111-8111-111111111111')

function makeTab(): TerminalTab {
  return {
    id: 'tab-1',
    ptyId: 'pty-1',
    worktreeId: 'wt-1',
    title: 'Claude',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
}

function makeEntry(overrides: Partial<AgentStatusEntry>): AgentStatusEntry {
  return {
    state: 'done',
    prompt: 'fix bug',
    updatedAt: 2_000,
    stateStartedAt: 2_000,
    paneKey: PANE,
    agentType: 'claude',
    stateHistory: [],
    ...overrides
  }
}

function makeSource(args: {
  entry?: AgentStatusEntry
  retained?: Record<string, RetainedAgentEntry>
  ackAt?: number
  withTab?: boolean
}): Parameters<typeof countUnreadAgentPaneThreads>[0] {
  return {
    agentStatusByPaneKey: args.entry ? { [PANE]: args.entry } : {},
    migrationUnsupportedByPtyId: {},
    retainedAgentsByPaneKey: args.retained ?? {},
    tabsByWorktree: args.withTab === false ? {} : { 'wt-1': [makeTab()] },
    worktreeMap: new Map(),
    repoMap: new Map(),
    acknowledgedAgentsByPaneKey: { [PANE]: args.ackAt ?? 0 },
    now: 2_000
  }
}

describe('countUnreadAgentPaneThreads', () => {
  it('counts an unacknowledged done as one unread thread', () => {
    expect(countUnreadAgentPaneThreads(makeSource({ entry: makeEntry({}) }))).toBe(1)
  })

  it('drops to zero once the pane is acknowledged, mirroring "Mark all read"', () => {
    expect(countUnreadAgentPaneThreads(makeSource({ entry: makeEntry({}), ackAt: 2_500 }))).toBe(0)
  })

  it('counts one thread per pane even with multiple unread events', () => {
    const entry = makeEntry({
      stateHistory: [
        { state: 'done', prompt: 'first', startedAt: 1_000 },
        { state: 'blocked', prompt: 'second', startedAt: 1_500 }
      ]
    })
    expect(countUnreadAgentPaneThreads(makeSource({ entry }))).toBe(1)
  })

  // Why: the Agents page cannot list a pane without tab context, so the badge must not count it either.
  it('ignores panes whose tab is gone from tabsByWorktree', () => {
    expect(countUnreadAgentPaneThreads(makeSource({ entry: makeEntry({}), withTab: false }))).toBe(
      0
    )
  })

  it('counts retained non-done agents that the Agents page lists as unread', () => {
    const retained: RetainedAgentEntry = {
      entry: makeEntry({ state: 'blocked' }),
      worktreeId: 'wt-1',
      tab: makeTab(),
      agentType: 'claude',
      startedAt: 1_000
    }
    expect(countUnreadAgentPaneThreads(makeSource({ retained: { [PANE]: retained } }))).toBe(1)
  })
})

describe('countUnreadAgentPaneThreads session-boundary rows (STA-3386)', () => {
  it('does not count a session-boundary done as unread', () => {
    const source = makeSource({ entry: makeEntry({ sessionBoundary: true }) })
    expect(countUnreadAgentPaneThreads(source)).toBe(0)
  })

  it('keeps counting a real completion displaced into history by a session boundary', () => {
    // Why: agent finished (unacknowledged), then the user resumed the session — the
    // boundary row replaces the live done but the finish must stay unread in the badge.
    const source = makeSource({
      entry: makeEntry({
        sessionBoundary: true,
        stateHistory: [{ state: 'done', prompt: 'fix bug', startedAt: 1_000 }]
      })
    })
    expect(countUnreadAgentPaneThreads(source)).toBe(1)
  })

  it('stops counting the displaced completion once acknowledged', () => {
    const source = makeSource({
      entry: makeEntry({
        sessionBoundary: true,
        stateHistory: [{ state: 'done', prompt: 'fix bug', startedAt: 1_000 }]
      }),
      ackAt: 1_500
    })
    expect(countUnreadAgentPaneThreads(source)).toBe(0)
  })
})
