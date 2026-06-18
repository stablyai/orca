import { describe, expect, it } from 'vitest'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { AppState } from '../types'
import { createTestStore, makeTab } from './store-test-helpers'

function makeAgentEntry(overrides: {
  paneKey: string
  worktreeId: string
  sessionId?: string
  providerSessionKey?: 'session_id' | 'conversation_id' | 'session_path'
  agentType?: AgentStatusEntry['agentType']
  promptInteractions?: AgentStatusEntry['promptInteractions']
}): AgentStatusEntry {
  return {
    state: 'working',
    prompt: 'finish the task',
    updatedAt: 1,
    stateStartedAt: 1,
    stateHistory: [],
    agentType: overrides.agentType ?? 'claude',
    paneKey: overrides.paneKey,
    worktreeId: overrides.worktreeId,
    ...(overrides.promptInteractions ? { promptInteractions: overrides.promptInteractions } : {}),
    ...(overrides.sessionId
      ? {
          providerSession: {
            key: overrides.providerSessionKey ?? 'session_id',
            id: overrides.sessionId
          }
        }
      : {})
  }
}

describe('captureAllSleepingAgentSessions', () => {
  it('checkpoints a live resumable provider session before quit-time capture', () => {
    const store = createTestStore()
    store.setState({
      tabsByWorktree: {
        'wt-1': [makeTab({ id: 'tab-1', worktreeId: 'wt-1' })]
      }
    } as Partial<AppState>)

    store.getState().setAgentStatus(
      'tab-1:leaf-1',
      {
        state: 'working',
        prompt: 'finish the task',
        agentType: 'codex'
      },
      'Codex',
      { updatedAt: 10, stateStartedAt: 10 },
      { tabId: 'tab-1', worktreeId: 'wt-1' },
      { providerSession: { key: 'session_id', id: 'codex-session-1' } }
    )

    // Why: Windows update/reboot exits can miss beforeunload; the provider
    // session handle must already be durable for pane-level cold restore.
    expect(store.getState().sleepingAgentSessionsByPaneKey['tab-1:leaf-1']).toMatchObject({
      agent: 'codex',
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      providerSession: { key: 'session_id', id: 'codex-session-1' },
      origin: 'live'
    })
  })

  it('does not rewrite the live checkpoint for same-session status ticks', () => {
    const store = createTestStore()
    store.setState({
      tabsByWorktree: {
        'wt-1': [makeTab({ id: 'tab-1', worktreeId: 'wt-1' })]
      }
    } as Partial<AppState>)

    store.getState().setAgentStatus(
      'tab-1:leaf-1',
      {
        state: 'working',
        prompt: 'first prompt',
        agentType: 'codex'
      },
      'Codex',
      { updatedAt: 10, stateStartedAt: 10 },
      { tabId: 'tab-1', worktreeId: 'wt-1' },
      { providerSession: { key: 'session_id', id: 'codex-session-1' } }
    )
    const firstRecord = store.getState().sleepingAgentSessionsByPaneKey['tab-1:leaf-1']

    store.getState().setAgentStatus(
      'tab-1:leaf-1',
      {
        state: 'working',
        prompt: 'second prompt',
        agentType: 'codex'
      },
      'Codex',
      { updatedAt: 20, stateStartedAt: 10 },
      { tabId: 'tab-1', worktreeId: 'wt-1' },
      { providerSession: { key: 'session_id', id: 'codex-session-1' } }
    )

    expect(store.getState().sleepingAgentSessionsByPaneKey['tab-1:leaf-1']).toBe(firstRecord)
  })

  it('clears the live checkpoint when the agent finishes', () => {
    const store = createTestStore()
    store.setState({
      tabsByWorktree: {
        'wt-1': [makeTab({ id: 'tab-1', worktreeId: 'wt-1' })]
      }
    } as Partial<AppState>)

    store.getState().setAgentStatus(
      'tab-1:leaf-1',
      {
        state: 'working',
        prompt: 'finish the task',
        agentType: 'codex'
      },
      'Codex',
      { updatedAt: 10, stateStartedAt: 10 },
      { tabId: 'tab-1', worktreeId: 'wt-1' },
      { providerSession: { key: 'session_id', id: 'codex-session-1' } }
    )
    store.getState().setAgentStatus(
      'tab-1:leaf-1',
      {
        state: 'done',
        prompt: 'finish the task',
        agentType: 'codex'
      },
      'Codex',
      { updatedAt: 20, stateStartedAt: 10 },
      { tabId: 'tab-1', worktreeId: 'wt-1' },
      { providerSession: { key: 'session_id', id: 'codex-session-1' } }
    )

    expect(store.getState().sleepingAgentSessionsByPaneKey['tab-1:leaf-1']).toBeUndefined()
  })

  it('captures resumable agents across every worktree, not just one', () => {
    const store = createTestStore()
    store.setState({
      tabsByWorktree: {
        'wt-1': [makeTab({ id: 'tab-1', worktreeId: 'wt-1' })],
        'wt-2': [makeTab({ id: 'tab-2', worktreeId: 'wt-2' })]
      },
      agentStatusByPaneKey: {
        'tab-1:leaf-1': makeAgentEntry({
          paneKey: 'tab-1:leaf-1',
          worktreeId: 'wt-1',
          sessionId: 'sess-1'
        }),
        'tab-2:leaf-2': makeAgentEntry({
          paneKey: 'tab-2:leaf-2',
          worktreeId: 'wt-2',
          sessionId: 'sess-2'
        })
      }
    } as Partial<AppState>)

    store.getState().captureAllSleepingAgentSessions()

    const records = store.getState().sleepingAgentSessionsByPaneKey
    expect(records['tab-1:leaf-1']).toMatchObject({
      agent: 'claude',
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      providerSession: { key: 'session_id', id: 'sess-1' },
      origin: 'quit'
    })
    expect(records['tab-2:leaf-2']).toMatchObject({
      agent: 'claude',
      worktreeId: 'wt-2',
      tabId: 'tab-2',
      providerSession: { key: 'session_id', id: 'sess-2' },
      origin: 'quit'
    })
  })

  it('captures done forkable agents as archived fork sources', () => {
    const store = createTestStore()
    const entry = makeAgentEntry({
      paneKey: 'tab-1:leaf-1',
      worktreeId: 'wt-1',
      sessionId: 'sess-1',
      promptInteractions: [
        {
          id: 'claude-message-1',
          prompt: 'finish the task',
          observedAt: 1,
          agentType: 'claude'
        }
      ]
    })
    entry.state = 'done'
    store.setState({
      tabsByWorktree: {
        'wt-1': [makeTab({ id: 'tab-1', worktreeId: 'wt-1' })]
      },
      agentStatusByPaneKey: { 'tab-1:leaf-1': entry }
    } as Partial<AppState>)

    store.getState().captureAllSleepingAgentSessions()

    expect(store.getState().sleepingAgentSessionsByPaneKey).toEqual({})
    expect(store.getState().archivedForkableAgentSessionsByPaneKey['tab-1:leaf-1']).toMatchObject({
      agent: 'claude',
      providerSession: { key: 'session_id', id: 'sess-1' },
      promptInteractions: [
        {
          id: 'claude-message-1',
          prompt: 'finish the task',
          observedAt: 1,
          agentType: 'claude'
        }
      ],
      archiveReason: 'quit'
    })
  })

  it('captures done Pi session-path agents as archived fork sources', () => {
    const store = createTestStore()
    const entry = makeAgentEntry({
      paneKey: 'tab-1:leaf-1',
      worktreeId: 'wt-1',
      sessionId: '/home/dev/.pi/sessions/session.jsonl',
      providerSessionKey: 'session_path',
      agentType: 'pi'
    })
    entry.state = 'done'
    store.setState({
      tabsByWorktree: {
        'wt-1': [makeTab({ id: 'tab-1', worktreeId: 'wt-1' })]
      },
      agentStatusByPaneKey: { 'tab-1:leaf-1': entry }
    } as Partial<AppState>)

    store.getState().captureAllSleepingAgentSessions()

    expect(store.getState().sleepingAgentSessionsByPaneKey).toEqual({})
    expect(store.getState().archivedForkableAgentSessionsByPaneKey['tab-1:leaf-1']).toMatchObject({
      agent: 'pi',
      providerSession: {
        key: 'session_path',
        id: '/home/dev/.pi/sessions/session.jsonl'
      },
      archiveReason: 'quit'
    })
  })

  it('skips done agents without provider-native fork support', () => {
    const store = createTestStore()
    const entry = makeAgentEntry({
      paneKey: 'tab-1:leaf-1',
      worktreeId: 'wt-1',
      sessionId: 'sess-1',
      agentType: 'gemini'
    })
    entry.state = 'done'
    store.setState({
      tabsByWorktree: {
        'wt-1': [makeTab({ id: 'tab-1', worktreeId: 'wt-1' })]
      },
      agentStatusByPaneKey: { 'tab-1:leaf-1': entry }
    } as Partial<AppState>)

    store.getState().captureAllSleepingAgentSessions()

    expect(store.getState().sleepingAgentSessionsByPaneKey).toEqual({})
    expect(store.getState().archivedForkableAgentSessionsByPaneKey).toEqual({})
  })

  it('captures retained forkable agents as archived fork sources', () => {
    const store = createTestStore()
    const entry = makeAgentEntry({
      paneKey: 'tab-1:leaf-1',
      worktreeId: 'wt-1',
      sessionId: 'sess-1'
    })
    entry.state = 'done'
    const tab = makeTab({ id: 'tab-1', worktreeId: 'wt-1' })
    store.setState({
      retainedAgentsByPaneKey: {
        'tab-1:leaf-1': {
          entry,
          worktreeId: 'wt-1',
          tab,
          agentType: 'claude',
          startedAt: 1
        }
      }
    } as Partial<AppState>)

    store.getState().captureAllSleepingAgentSessions()

    expect(store.getState().sleepingAgentSessionsByPaneKey).toEqual({})
    expect(store.getState().archivedForkableAgentSessionsByPaneKey['tab-1:leaf-1']).toMatchObject({
      agent: 'claude',
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      providerSession: { key: 'session_id', id: 'sess-1' },
      archiveReason: 'quit'
    })
  })

  it('does not replace existing sleep records with retained fork-only records', () => {
    const store = createTestStore()
    const entry = makeAgentEntry({
      paneKey: 'tab-1:leaf-1',
      worktreeId: 'wt-1',
      sessionId: 'sess-1'
    })
    entry.state = 'done'
    const existingRecord = {
      paneKey: 'tab-1:leaf-1',
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      agent: 'claude' as const,
      providerSession: { key: 'session_id' as const, id: 'sess-1' },
      prompt: 'continue',
      state: 'working' as const,
      capturedAt: 1,
      updatedAt: 1,
      origin: 'worktree-sleep' as const
    }
    store.setState({
      sleepingAgentSessionsByPaneKey: { 'tab-1:leaf-1': existingRecord },
      retainedAgentsByPaneKey: {
        'tab-1:leaf-1': {
          entry,
          worktreeId: 'wt-1',
          tab: makeTab({ id: 'tab-1', worktreeId: 'wt-1' }),
          agentType: 'claude',
          startedAt: 1
        }
      }
    } as Partial<AppState>)

    store.getState().captureAllSleepingAgentSessions()

    expect(store.getState().sleepingAgentSessionsByPaneKey['tab-1:leaf-1']).toBe(existingRecord)
    expect(store.getState().archivedForkableAgentSessionsByPaneKey['tab-1:leaf-1']).toMatchObject({
      agent: 'claude',
      archiveReason: 'quit'
    })
  })

  it('skips retained agents that are not complete', () => {
    const store = createTestStore()
    const entry = makeAgentEntry({
      paneKey: 'tab-1:leaf-1',
      worktreeId: 'wt-1',
      sessionId: 'sess-1'
    })
    entry.state = 'blocked'
    store.setState({
      retainedAgentsByPaneKey: {
        'tab-1:leaf-1': {
          entry,
          worktreeId: 'wt-1',
          tab: makeTab({ id: 'tab-1', worktreeId: 'wt-1' }),
          agentType: 'claude',
          startedAt: 1
        }
      }
    } as Partial<AppState>)

    store.getState().captureAllSleepingAgentSessions()

    expect(store.getState().sleepingAgentSessionsByPaneKey).toEqual({})
    expect(store.getState().archivedForkableAgentSessionsByPaneKey).toEqual({})
  })

  it('skips agents without a resumable provider session', () => {
    const store = createTestStore()
    store.setState({
      tabsByWorktree: {
        'wt-1': [makeTab({ id: 'tab-1', worktreeId: 'wt-1' })]
      },
      agentStatusByPaneKey: {
        'tab-1:leaf-1': makeAgentEntry({ paneKey: 'tab-1:leaf-1', worktreeId: 'wt-1' })
      }
    } as Partial<AppState>)

    store.getState().captureAllSleepingAgentSessions()

    expect(store.getState().sleepingAgentSessionsByPaneKey).toEqual({})
  })

  it('captures entries attributed only via tab prefix when the entry has no worktreeId', () => {
    const store = createTestStore()
    const entry = makeAgentEntry({
      paneKey: 'tab-1:leaf-1',
      worktreeId: 'wt-1',
      sessionId: 'sess-1'
    })
    delete entry.worktreeId
    store.setState({
      tabsByWorktree: {
        'wt-1': [makeTab({ id: 'tab-1', worktreeId: 'wt-1' })]
      },
      agentStatusByPaneKey: { 'tab-1:leaf-1': entry }
    } as Partial<AppState>)

    store.getState().captureAllSleepingAgentSessions()

    expect(store.getState().sleepingAgentSessionsByPaneKey['tab-1:leaf-1']).toMatchObject({
      worktreeId: 'wt-1',
      providerSession: { key: 'session_id', id: 'sess-1' }
    })
  })
})
