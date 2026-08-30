import { describe, expect, it } from 'vitest'
import {
  AGENT_STATE_HISTORY_MAX,
  type AgentStateHistoryEntry,
  type AgentStatusEntry
} from '../../../../shared/agent-status-types'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { buildWorktreeAgentRows } from './worktree-agent-rows'

const BUSY_LEAF_ID = '11111111-1111-4111-8111-111111111111'
const QUIET_LEAF_ID = '22222222-2222-4222-8222-222222222222'
const BUSY_PANE_KEY = makePaneKey('tab-busy', BUSY_LEAF_ID)
const QUIET_PANE_KEY = makePaneKey('tab-quiet', QUIET_LEAF_ID)

const NOW = 900_000

function makeTab(id: string, sortOrder: number): TerminalTab {
  return {
    id,
    worktreeId: 'wt-1',
    ptyId: null,
    title: 'Claude',
    customTitle: null,
    color: null,
    sortOrder,
    createdAt: 0
  }
}

/** A history window that has already wrapped: the session's real first states were trimmed away. */
function wrappedHistory(oldestRetainedAt: number): AgentStateHistoryEntry[] {
  return Array.from({ length: AGENT_STATE_HISTORY_MAX }, (_, index) => ({
    state: index % 2 === 0 ? ('working' as const) : ('done' as const),
    prompt: `turn ${index}`,
    startedAt: oldestRetainedAt + index * 1000
  }))
}

function makeEntry(paneKey: string, overrides: Partial<AgentStatusEntry>): AgentStatusEntry {
  return {
    paneKey,
    state: 'working',
    prompt: 'keep going',
    agentType: 'claude',
    stateStartedAt: NOW - 1000,
    updatedAt: NOW - 1000,
    stateHistory: [],
    ...overrides
  }
}

describe('worktree agent row order across new activity', () => {
  // Why: the busy agent started FIRST, so it must stay first. Its stateHistory has wrapped the
  // AGENT_STATE_HISTORY_MAX cap, so stateHistory[0] no longer marks the session start — reading
  // it directly would rank the row by its most recent turns and jump it past the quiet agent.
  it('keeps the older session ahead once its history window has wrapped', () => {
    const rows = buildWorktreeAgentRows({
      tabs: [makeTab('tab-busy', 0), makeTab('tab-quiet', 1)],
      entries: [
        makeEntry(BUSY_PANE_KEY, {
          firstStateStartedAt: 1000,
          stateHistory: wrappedHistory(500_000)
        }),
        makeEntry(QUIET_PANE_KEY, { firstStateStartedAt: 2000, stateStartedAt: 2000 })
      ],
      retained: [],
      now: NOW
    })

    expect(rows.map((row) => row.paneKey)).toEqual([BUSY_PANE_KEY, QUIET_PANE_KEY])
    expect(rows[0].startedAt).toBe(1000)
  })

  it('does not re-sort the busy row when its next turn slides the history window', () => {
    const buildRows = (oldestRetainedAt: number): string[] =>
      buildWorktreeAgentRows({
        tabs: [makeTab('tab-busy', 0), makeTab('tab-quiet', 1)],
        entries: [
          makeEntry(BUSY_PANE_KEY, {
            firstStateStartedAt: 1000,
            stateHistory: wrappedHistory(oldestRetainedAt)
          }),
          makeEntry(QUIET_PANE_KEY, { firstStateStartedAt: 2000, stateStartedAt: 2000 })
        ],
        retained: [],
        now: NOW
      }).map((row) => row.paneKey)

    const before = buildRows(500_000)
    // One more turn: the oldest retained history row is dropped, so stateHistory[0] advances.
    const after = buildRows(502_000)

    expect(after).toEqual(before)
    expect(after).toEqual([BUSY_PANE_KEY, QUIET_PANE_KEY])
  })

  // Why: entries rehydrated from disk (or synthesized by main) carry no latched origin; they must
  // still order by their oldest known state rather than collapsing to the current status clock.
  it('falls back to the oldest retained history row when no origin was latched', () => {
    const rows = buildWorktreeAgentRows({
      tabs: [makeTab('tab-busy', 0), makeTab('tab-quiet', 1)],
      entries: [
        makeEntry(BUSY_PANE_KEY, { stateHistory: wrappedHistory(1000) }),
        makeEntry(QUIET_PANE_KEY, { stateStartedAt: 2000 })
      ],
      retained: [],
      now: NOW
    })

    expect(rows.map((row) => row.paneKey)).toEqual([BUSY_PANE_KEY, QUIET_PANE_KEY])
    expect(rows[0].startedAt).toBe(1000)
  })
})
