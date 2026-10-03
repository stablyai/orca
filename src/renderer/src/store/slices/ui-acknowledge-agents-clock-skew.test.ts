import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createUIStore } from './ui-slice-test-harness'
import type { AppState } from '../types'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import { makePaneKey } from '../../../../shared/stable-pane-id'

// Why: an SSH/remote execution host stamps turns with ITS clock. When that clock runs ahead, every
// unread rule (`ackAt < turnTimestamp`) stayed true after an ack, so the row could never be marked
// read and its auto-ack effect re-fired on each new millisecond — the React #185 update loop.

const NOW = new Date('2026-06-02T12:00:00Z').getTime()
const SKEW_MS = 90_000
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const PANE_KEY = makePaneKey('tab-1', LEAF_ID)

function makeAgentEntry(overrides: Partial<AgentStatusEntry> = {}): AgentStatusEntry {
  return {
    state: 'done',
    prompt: 'Review complete',
    updatedAt: NOW,
    stateStartedAt: NOW,
    agentType: 'codex',
    paneKey: PANE_KEY,
    stateHistory: [],
    ...overrides
  }
}

function makeTerminalTab(id: string, worktreeId: string): TerminalTab {
  return {
    id,
    worktreeId,
    ptyId: null,
    title: 'Terminal',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: NOW
  }
}

describe('acknowledgeAgents with a clock-skewed execution host', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('clears unread for a live turn stamped ahead of the local clock in one acknowledge', () => {
    const store = createUIStore()
    const futureStartedAt = NOW + SKEW_MS
    store.setState({
      tabsByWorktree: { 'wt-1': [makeTerminalTab('tab-1', 'wt-1')] },
      agentStatusByPaneKey: {
        [PANE_KEY]: makeAgentEntry({ stateStartedAt: futureStartedAt, updatedAt: futureStartedAt })
      }
    } as Partial<AppState>)

    store.getState().acknowledgeAgents([PANE_KEY])

    const ackAt = store.getState().acknowledgedAgentsByPaneKey[PANE_KEY]
    expect(ackAt).toBe(futureStartedAt)
    expect(ackAt < futureStartedAt).toBe(false)
  })

  // Child work can hold the row open past the main agent's cut; the failed mark reads the cut's clock.
  it("stamps at least the main agent's own clock when it is newer than the row's", () => {
    const store = createUIStore()
    const cutAt = NOW + SKEW_MS
    const heldOpen: Partial<AppState> = {
      agentStatusByPaneKey: {
        [PANE_KEY]: makeAgentEntry({
          state: 'working',
          mainAgent: { state: 'done', outcome: 'interruption', stateStartedAt: cutAt }
        })
      }
    }
    store.setState(heldOpen)

    store.getState().acknowledgeAgents([PANE_KEY])

    expect(store.getState().acknowledgedAgentsByPaneKey[PANE_KEY]).toBe(cutAt)
  })

  it('stops rewriting the ack map once a future-stamped turn is acknowledged', () => {
    const store = createUIStore()
    const futureStartedAt = NOW + SKEW_MS
    store.setState({
      agentStatusByPaneKey: {
        [PANE_KEY]: makeAgentEntry({ stateStartedAt: futureStartedAt, updatedAt: futureStartedAt })
      }
    } as Partial<AppState>)

    store.getState().acknowledgeAgents([PANE_KEY])
    const firstMap = store.getState().acknowledgedAgentsByPaneKey

    // Later millisecond, same turn: the retry that used to allocate a new map (and re-render forever).
    vi.setSystemTime(NOW + 1_000)
    store.getState().acknowledgeAgents([PANE_KEY])

    expect(store.getState().acknowledgedAgentsByPaneKey).toBe(firstMap)
  })

  it('covers a retained row and a future history event on the same pane', () => {
    const store = createUIStore()
    const futureHistoryAt = NOW + SKEW_MS
    store.setState({
      retainedAgentsByPaneKey: {
        [PANE_KEY]: {
          entry: makeAgentEntry({
            stateStartedAt: NOW + 1_000,
            stateHistory: [{ state: 'blocked', prompt: 'p', startedAt: futureHistoryAt }]
          }),
          worktreeId: 'wt-1',
          tab: makeTerminalTab('tab-1', 'wt-1'),
          agentType: 'codex',
          startedAt: NOW + 1_000
        }
      }
    } as Partial<AppState>)

    store.getState().acknowledgeAgents([PANE_KEY])

    expect(store.getState().acknowledgedAgentsByPaneKey[PANE_KEY]).toBe(futureHistoryAt)
  })

  it('covers a future-stamped migration-unsupported row, which Activity renders as a blocked event', () => {
    const store = createUIStore()
    const futureUpdatedAt = NOW + SKEW_MS
    store.setState({
      migrationUnsupportedByPtyId: {
        'pty-1': {
          ptyId: 'pty-1',
          paneKey: PANE_KEY,
          reason: 'legacy-numeric-pane-key',
          source: 'ssh',
          updatedAt: futureUpdatedAt
        }
      }
    } as Partial<AppState>)

    store.getState().acknowledgeAgents([PANE_KEY])

    expect(store.getState().acknowledgedAgentsByPaneKey[PANE_KEY]).toBe(futureUpdatedAt)
  })

  it('still stamps the local clock when the turn is not ahead of it', () => {
    const store = createUIStore()
    store.setState({
      agentStatusByPaneKey: {
        [PANE_KEY]: makeAgentEntry({ stateStartedAt: NOW - 5_000, updatedAt: NOW - 5_000 })
      }
    } as Partial<AppState>)

    store.getState().acknowledgeAgents([PANE_KEY])

    expect(store.getState().acknowledgedAgentsByPaneKey[PANE_KEY]).toBe(NOW)
  })
})
