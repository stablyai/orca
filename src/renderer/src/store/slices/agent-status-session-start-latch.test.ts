import { describe, expect, it } from 'vitest'
import { AGENT_STATE_HISTORY_MAX } from '../../../../shared/agent-status-types'
import { agentEntrySessionStartedAt } from '../../../../shared/agent-session-start-time'
import { createTestStore } from './store-test-helpers'

const PANE_KEY = 'tab-1:leaf-1'
const SESSION_START = 10_000

function runTurns(store: ReturnType<typeof createTestStore>, turns: number): void {
  for (let turn = 0; turn < turns; turn++) {
    const at = SESSION_START + (turn + 1) * 1000
    store
      .getState()
      .setAgentStatus(
        PANE_KEY,
        { state: 'working', prompt: `turn ${turn}`, agentType: 'claude' },
        'Claude',
        { updatedAt: at, stateStartedAt: at }
      )
    store
      .getState()
      .setAgentStatus(
        PANE_KEY,
        { state: 'done', prompt: `turn ${turn}`, agentType: 'claude' },
        'Claude',
        { updatedAt: at + 500, stateStartedAt: at + 500 }
      )
  }
}

describe('agent status session-start latch', () => {
  it('latches the first reported state as the session start', () => {
    const store = createTestStore()
    store
      .getState()
      .setAgentStatus(
        PANE_KEY,
        { state: 'working', prompt: 'first prompt', agentType: 'claude' },
        'Claude',
        { updatedAt: SESSION_START, stateStartedAt: SESSION_START }
      )

    expect(store.getState().agentStatusByPaneKey[PANE_KEY]?.firstStateStartedAt).toBe(SESSION_START)
  })

  // Why: stateHistory is a rolling window that trims oldest-first, so past the cap its first row
  // is a recent turn. Without a latched origin the sidebar's row clock would follow activity.
  it('holds the session start once stateHistory has wrapped its cap', () => {
    const store = createTestStore()
    store
      .getState()
      .setAgentStatus(
        PANE_KEY,
        { state: 'working', prompt: 'first prompt', agentType: 'claude' },
        'Claude',
        { updatedAt: SESSION_START, stateStartedAt: SESSION_START }
      )
    // Two transitions per turn, so this comfortably overruns AGENT_STATE_HISTORY_MAX.
    runTurns(store, AGENT_STATE_HISTORY_MAX)

    const entry = store.getState().agentStatusByPaneKey[PANE_KEY]
    expect(entry).toBeDefined()
    expect(entry!.stateHistory).toHaveLength(AGENT_STATE_HISTORY_MAX)
    // The window really did slide: the oldest retained row is no longer the session start.
    expect(entry!.stateHistory[0]!.startedAt).toBeGreaterThan(SESSION_START)
    expect(entry!.firstStateStartedAt).toBe(SESSION_START)
    expect(agentEntrySessionStartedAt(entry!)).toBe(SESSION_START)
  })

  it('starts a fresh session clock after the pane status is dropped', () => {
    const store = createTestStore()
    store
      .getState()
      .setAgentStatus(
        PANE_KEY,
        { state: 'working', prompt: 'first prompt', agentType: 'claude' },
        'Claude',
        { updatedAt: SESSION_START, stateStartedAt: SESSION_START }
      )
    store.getState().dropAgentStatus(PANE_KEY)
    store
      .getState()
      .setAgentStatus(
        PANE_KEY,
        { state: 'working', prompt: 'new session', agentType: 'claude' },
        'Claude',
        { updatedAt: 900_000, stateStartedAt: 900_000 }
      )

    expect(store.getState().agentStatusByPaneKey[PANE_KEY]?.firstStateStartedAt).toBe(900_000)
  })
})
