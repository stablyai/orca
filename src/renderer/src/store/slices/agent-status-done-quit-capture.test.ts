import { describe, expect, it } from 'vitest'
import type { AppState } from '../types'
import { createTestStore, makeTab } from './store-test-helpers'

describe('done agent quit capture', () => {
  it('captures a done Codex session that is still waiting for the next TUI input', () => {
    const store = createTestStore()
    store.setState({
      tabsByWorktree: {
        'wt-1': [makeTab({ id: 'tab-1', worktreeId: 'wt-1' })]
      }
    } as Partial<AppState>)
    const providerSession = { key: 'session_id' as const, id: 'sess-1' }
    store
      .getState()
      .setAgentStatus(
        'tab-1:leaf-1',
        { state: 'working', prompt: 'finish the task', agentType: 'codex' },
        'Codex',
        { updatedAt: 10, stateStartedAt: 10 },
        { tabId: 'tab-1', worktreeId: 'wt-1' },
        { providerSession }
      )
    store.getState().setAgentStatus(
      'tab-1:leaf-1',
      {
        state: 'done',
        prompt: 'finish the task',
        agentType: 'codex',
        lastAssistantMessage: 'Task complete'
      },
      'Codex',
      { updatedAt: 20, stateStartedAt: 20 },
      { tabId: 'tab-1', worktreeId: 'wt-1' },
      { providerSession }
    )

    expect(store.getState().sleepingAgentSessionsByPaneKey).toEqual({})

    store.getState().captureAllSleepingAgentSessions('quit')

    expect(store.getState().sleepingAgentSessionsByPaneKey['tab-1:leaf-1']).toMatchObject({
      agent: 'codex',
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      providerSession,
      state: 'done',
      lastAssistantMessage: 'Task complete',
      origin: 'quit'
    })
  })
})
