import { describe, expect, it } from 'vitest'
import { createTestStore } from './store-test-helpers'

const PANE = 'tab-1:11111111-1111-4111-8111-111111111111'

describe("the host's turn start on a renderer status entry", () => {
  it('lands on the entry from the host timing and follows each host write', () => {
    const store = createTestStore()
    store
      .getState()
      .setAgentStatus(PANE, { state: 'working', prompt: 'go', agentType: 'claude' }, undefined, {
        updatedAt: 1_000,
        stateStartedAt: 1_000,
        turnStartedAt: 900
      })
    expect(store.getState().agentStatusByPaneKey[PANE]?.turnStartedAt).toBe(900)

    // The same prompt sent again: the state never left working, the host stamped a new turn.
    store
      .getState()
      .setAgentStatus(PANE, { state: 'working', prompt: 'go', agentType: 'claude' }, undefined, {
        updatedAt: 2_000,
        stateStartedAt: 1_000,
        turnStartedAt: 1_900
      })
    expect(store.getState().agentStatusByPaneKey[PANE]?.turnStartedAt).toBe(1_900)
  })

  it('keeps the stamp behind an unchanged state when a writer carries none, and drops it on a state edge', () => {
    const store = createTestStore()
    store
      .getState()
      .setAgentStatus(PANE, { state: 'working', prompt: 'go', agentType: 'claude' }, undefined, {
        updatedAt: 1_000,
        stateStartedAt: 1_000,
        turnStartedAt: 900
      })
    // A renderer-side OSC repaint has no turn clock of its own.
    store.getState().setAgentStatus(PANE, {
      state: 'working',
      prompt: 'go',
      agentType: 'claude',
      toolName: 'Bash'
    })
    expect(store.getState().agentStatusByPaneKey[PANE]?.turnStartedAt).toBe(900)

    store.getState().setAgentStatus(PANE, { state: 'done', prompt: 'go', agentType: 'claude' })
    expect(store.getState().agentStatusByPaneKey[PANE]?.turnStartedAt).toBeUndefined()
  })
})
