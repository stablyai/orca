import { describe, expect, it } from 'vitest'
import type { AppState } from '../types'
import { createTestStore, makeTab } from './store-test-helpers'

describe('agent status execution owner', () => {
  it('refreshes live recovery ownership when the same session reports from a new owner', () => {
    const store = createTestStore()
    store.setState({
      tabsByWorktree: {
        'wt-1': [makeTab({ id: 'tab-1', worktreeId: 'wt-1' })]
      }
    } as Partial<AppState>)
    const providerSession = { key: 'session_id' as const, id: 'codex-session-1' }
    const setStatus = (
      executionHostId: 'local' | 'runtime:runtime-a',
      connectionId: null | string
    ) =>
      store
        .getState()
        .setAgentStatus(
          'tab-1:leaf-1',
          { state: 'working', prompt: 'first task', agentType: 'codex' },
          'Codex',
          { updatedAt: 10, stateStartedAt: 10 },
          { tabId: 'tab-1', worktreeId: 'wt-1', executionHostId, connectionId },
          { providerSession }
        )

    setStatus('runtime:runtime-a', 'ssh-a')
    setStatus('local', null)

    expect(store.getState().sleepingAgentSessionsByPaneKey['tab-1:leaf-1']).toMatchObject({
      executionHostId: 'local',
      connectionId: null
    })
  })

  it('clears sleeping and live status only for the selected execution host', () => {
    const store = createTestStore()
    const makeRecord = (paneKey: string, executionHostId: 'local' | 'runtime:runtime-b') => ({
      paneKey,
      tabId: paneKey.split(':')[0],
      worktreeId: 'wt-1',
      executionHostId,
      agent: 'codex' as const,
      providerSession: { key: 'session_id' as const, id: 'session-1' },
      prompt: '',
      state: 'working' as const,
      capturedAt: 1,
      updatedAt: 1
    })
    const local = makeRecord('tab-local:leaf-1', 'local')
    const remote = makeRecord('tab-remote:leaf-1', 'runtime:runtime-b')
    store.setState({
      sleepingAgentSessionsByPaneKey: {
        [local.paneKey]: local,
        [remote.paneKey]: remote
      },
      agentStatusByPaneKey: {
        [local.paneKey]: {
          ...local,
          stateStartedAt: 1,
          stateHistory: [],
          agentType: 'codex'
        },
        [remote.paneKey]: {
          ...remote,
          stateStartedAt: 1,
          stateHistory: [],
          agentType: 'codex'
        }
      }
    } as Partial<AppState>)

    store.getState().clearSleepingAgentSessionsByWorktree('wt-1', 'local')
    store.getState().dropAgentStatusByWorktree('wt-1', { executionHostId: 'local' })

    expect(store.getState().sleepingAgentSessionsByPaneKey[local.paneKey]).toBeUndefined()
    expect(store.getState().sleepingAgentSessionsByPaneKey[remote.paneKey]).toBe(remote)
    expect(store.getState().agentStatusByPaneKey[local.paneKey]).toBeUndefined()
    expect(store.getState().agentStatusByPaneKey[remote.paneKey]).toBeDefined()
  })

  it('keeps a foreign sleeping record during manual sleep replacement', async () => {
    const store = createTestStore()
    const remote = {
      paneKey: 'tab-remote:leaf-1',
      tabId: 'tab-remote',
      worktreeId: 'wt-1',
      executionHostId: 'runtime:runtime-b' as const,
      agent: 'codex' as const,
      providerSession: { key: 'session_id' as const, id: 'session-1' },
      prompt: '',
      state: 'working' as const,
      capturedAt: 1,
      updatedAt: 1,
      origin: 'live' as const
    }
    store.setState({
      tabsByWorktree: { 'wt-1': [makeTab({ id: 'tab-local', worktreeId: 'wt-1' })] },
      sleepingAgentSessionsByPaneKey: { [remote.paneKey]: remote }
    } as Partial<AppState>)

    await store.getState().shutdownWorktreeTerminals('wt-1', {
      keepIdentifiers: true,
      shutdownReason: 'manual-sleep'
    })

    expect(store.getState().sleepingAgentSessionsByPaneKey[remote.paneKey]).toBe(remote)
  })
})
