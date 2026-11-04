import { describe, expect, it } from 'vitest'
import '../../../hooks/ipc-events/normalize-agent-status-event'
import { createTestStore } from '../store-test-helpers'

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

  it('keeps the launch config registry entry alive across a session-boundary done', () => {
    const store = createTestStore()
    store.setState({
      agentLaunchConfigByPaneKey: {
        [PANE]: {
          launchConfig: { agentArgs: '', agentEnv: {} },
          registeredAt: 1,
          identity: { agentType: 'claude', launchToken: 'token-1' }
        }
      }
    })

    store.getState().setAgentStatus(PANE, {
      state: 'done',
      prompt: '',
      agentType: 'claude',
      sessionBoundary: true
    })
    // Connection boundary must preserve registered-launch identity so resumed idle TUIs keep startup pane evidence.
    expect(store.getState().agentLaunchConfigByPaneKey[PANE]).toBeDefined()

    store.getState().setAgentStatus(PANE, {
      state: 'done',
      prompt: 'fix bug',
      agentType: 'claude',
      lastAssistantMessage: 'Done.'
    })
    expect(store.getState().agentLaunchConfigByPaneKey[PANE]).toBeUndefined()
  })

  it('pushes a real completion into history when a session boundary lands on it', () => {
    const store = createTestStore()
    store
      .getState()
      .setAgentStatus(PANE, { state: 'working', prompt: 'fix bug', agentType: 'claude' })
    store.getState().setAgentStatus(PANE, {
      state: 'done',
      prompt: 'fix bug',
      agentType: 'claude',
      lastAssistantMessage: 'Done.'
    })

    store.getState().setAgentStatus(PANE, {
      state: 'done',
      prompt: '',
      agentType: 'claude',
      sessionBoundary: true
    })

    const entry = store.getState().agentStatusByPaneKey[PANE]
    expect(entry.sessionBoundary).toBe(true)
    // Boundary entries read finished/unread state from history; losing real done erases unacknowledged completion.
    expect(entry.stateHistory.some((h) => h.state === 'done')).toBe(true)
  })

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
