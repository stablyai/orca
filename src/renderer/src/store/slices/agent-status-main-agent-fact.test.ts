import { describe, expect, it } from 'vitest'
import { normalizeAgentStatusEvent } from '../../hooks/ipc-events/normalize-agent-status-event'
import { createTestStore } from './store-test-helpers'

const PANE = 'tab-1:11111111-1111-4111-8111-111111111111'

function osc(revision: number) {
  return {
    origin: 'osc' as const,
    authorityId: 'renderer',
    incarnation: 0,
    revision,
    observedAt: revision,
    kind: 'snapshot' as const
  }
}

describe('the main agent fact on a renderer status entry', () => {
  it('lands on the entry from the IPC payload and is reused by reference when unchanged', () => {
    const store = createTestStore()
    const mainAgent = { state: 'done' as const, outcome: 'failure' as const, stateStartedAt: 5 }
    store
      .getState()
      .setAgentStatus(PANE, { state: 'working', prompt: 'go', agentType: 'claude', mainAgent })
    const first = store.getState().agentStatusByPaneKey[PANE]
    expect(first.mainAgent).toEqual(mainAgent)

    store.getState().setAgentStatus(PANE, {
      state: 'working',
      prompt: 'go',
      agentType: 'claude',
      toolName: 'Read',
      mainAgent: { ...mainAgent }
    })
    expect(store.getState().agentStatusByPaneKey[PANE].mainAgent).toBe(first.mainAgent)
  })

  it('keeps the main agent behind an unchanged state when a writer carries none, and drops it on a state edge', () => {
    const store = createTestStore()
    const mainAgent = { state: 'done' as const, stateStartedAt: 5 }
    store
      .getState()
      .setAgentStatus(PANE, { state: 'working', prompt: 'go', agentType: 'claude', mainAgent })
    // A renderer-side OSC parse repaints the state with no main agent fact of its own.
    store.getState().setAgentStatus(PANE, {
      state: 'working',
      prompt: 'go',
      agentType: 'claude',
      toolName: 'Bash',
      observation: osc(1)
    })
    expect(store.getState().agentStatusByPaneKey[PANE].mainAgent).toEqual(mainAgent)

    store
      .getState()
      .setAgentStatus(PANE, {
        state: 'done',
        prompt: 'go',
        agentType: 'claude',
        observation: osc(2)
      })
    expect(store.getState().agentStatusByPaneKey[PANE].mainAgent).toBeUndefined()
  })

  it('drops the main agent when a hook row carries none, matching the host snapshot', () => {
    const store = createTestStore()
    store.getState().setAgentStatus(PANE, {
      state: 'working',
      prompt: 'go',
      agentType: 'claude',
      mainAgent: { state: 'done', stateStartedAt: 5 }
    })
    // The host lost its main agent record (unseeded restart, relay restart, old relay).
    store.getState().setAgentStatus(PANE, {
      state: 'working',
      prompt: 'go',
      agentType: 'claude',
      toolName: 'Bash'
    })
    expect(store.getState().agentStatusByPaneKey[PANE].mainAgent).toBeUndefined()
  })

  it('survives the IPC event normalizer', () => {
    const mainAgent = { state: 'working' as const, stateStartedAt: 9 }
    expect(
      normalizeAgentStatusEvent({
        paneKey: PANE,
        connectionId: null,
        receivedAt: 10,
        stateStartedAt: 9,
        state: 'working',
        prompt: 'go',
        mainAgent
      })?.mainAgent
    ).toEqual(mainAgent)
  })
})
