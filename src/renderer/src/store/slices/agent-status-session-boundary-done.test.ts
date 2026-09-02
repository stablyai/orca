import { describe, expect, it } from 'vitest'
import type { AppState } from '../types'
import { createTestStore } from './store-test-helpers'

describe('session-boundary done semantics (STA-3386)', () => {
  const PANE = 'tab-1:11111111-1111-4111-8111-111111111111'

  it('keeps the launch config registry entry alive across a session-boundary done', () => {
    const store = createTestStore()
    store.setState({
      agentLaunchConfigByPaneKey: {
        [PANE]: {
          launchConfig: { agentArgs: '', agentEnv: {} },
          identity: { agentType: 'claude' },
          launchToken: 'token-1'
        }
      }
    } as unknown as Partial<AppState>)

    store.getState().setAgentStatus(PANE, {
      state: 'done',
      prompt: '',
      agentType: 'claude',
      sessionBoundary: true
    })
    // Why: the session just CONNECTED — the registered-launch-agent identity must survive
    // or an idle resumed TUI loses its pane identity evidence at startup.
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
    // Why: the finished timestamp and unread badge fall through to history for boundary
    // entries — losing the real done here erases an unacknowledged completion.
    expect(entry.stateHistory.some((h) => h.state === 'done')).toBe(true)
  })

  it('never records a session boundary itself in state history', () => {
    const store = createTestStore()
    store.getState().setAgentStatus(PANE, {
      state: 'done',
      prompt: '',
      agentType: 'claude',
      sessionBoundary: true
    })
    store
      .getState()
      .setAgentStatus(PANE, { state: 'working', prompt: 'fix bug', agentType: 'claude' })

    const entry = store.getState().agentStatusByPaneKey[PANE]
    expect(entry.stateHistory.some((h) => h.state === 'done')).toBe(false)
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
