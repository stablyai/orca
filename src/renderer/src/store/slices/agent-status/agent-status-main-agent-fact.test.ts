import { describe, expect, it } from 'vitest'
import '../../../hooks/ipc-events/normalize-agent-status-event'
import { createTestStore } from '../../testing/app-store-test-fixture'

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

    store.getState().setAgentStatus(PANE, {
      state: 'done',
      prompt: 'go',
      agentType: 'claude',
      observation: osc(2)
    })
    expect(store.getState().agentStatusByPaneKey[PANE].mainAgent).toBeUndefined()
  })
})

describe('session-boundary done semantics (STA-3386)', () => {
  const PANE = 'tab-1:11111111-1111-4111-8111-111111111111'

  it('carries the flag across metadata-less done repaints but yields to turn evidence', () => {
    const store = createTestStore()
    store.getState().setAgentStatus(PANE, {
      state: 'done',
      prompt: '',
      agentType: 'claude',
      sessionBoundary: true
    })

    // Why: OSC 9999 repaints and reconnect replays re-deliver a metadata-less done.
    store.getState().setAgentStatus(PANE, { state: 'done', prompt: '', agentType: 'claude' })
    expect(store.getState().agentStatusByPaneKey[PANE].sessionBoundary).toBe(true)

    // Why: an assistant message proves a REAL completion — the flag must not suppress it.
    store.getState().setAgentStatus(PANE, {
      state: 'done',
      prompt: '',
      agentType: 'claude',
      lastAssistantMessage: 'Done.'
    })
    expect(store.getState().agentStatusByPaneKey[PANE].sessionBoundary).toBeUndefined()
  })
})
