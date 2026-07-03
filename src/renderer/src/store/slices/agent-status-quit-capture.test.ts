import { describe, expect, it } from 'vitest'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { AppState } from '../types'
import { collectSleepingAgentSessionRecordsForWorktree } from './agent-status'
import { createTestStore, makeTab } from './store-test-helpers'

function makeAgentEntry(overrides: {
  paneKey: string
  worktreeId: string
  sessionId?: string
}): AgentStatusEntry {
  return {
    state: 'working',
    prompt: 'finish the task',
    updatedAt: 1,
    stateStartedAt: 1,
    stateHistory: [],
    agentType: 'claude',
    paneKey: overrides.paneKey,
    worktreeId: overrides.worktreeId,
    ...(overrides.sessionId
      ? { providerSession: { key: 'session_id' as const, id: overrides.sessionId } }
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
    store.getState().registerAgentLaunchConfig(
      'tab-1:leaf-1',
      {
        agentArgs: '--model gpt-5',
        agentEnv: { CODEX_PROFILE: 'captured' }
      },
      { agentType: 'codex', launchToken: 'launch-token-1', tabId: 'tab-1', leafId: 'leaf-1' }
    )

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
      {
        providerSession: { key: 'session_id', id: 'codex-session-1' },
        launchToken: 'launch-token-1'
      }
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

  it('captures launch config into live checkpoints and refreshes late registration', () => {
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
    expect(
      store.getState().sleepingAgentSessionsByPaneKey['tab-1:leaf-1']?.launchConfig
    ).toBeUndefined()

    store.getState().registerAgentLaunchConfig(
      'tab-1:leaf-1',
      {
        agentArgs: '--model gpt-5',
        agentEnv: { CODEX_PROFILE: 'captured' }
      },
      {
        agentType: 'codex',
        tabId: 'tab-1',
        leafId: 'leaf-1'
      }
    )

    expect(store.getState().agentStatusByPaneKey['tab-1:leaf-1']).not.toHaveProperty('launchConfig')
    expect(store.getState().sleepingAgentSessionsByPaneKey['tab-1:leaf-1']?.launchConfig).toEqual({
      agentArgs: '--model gpt-5',
      agentEnv: { CODEX_PROFILE: 'captured' }
    })
  })

  it('keeps private launch config through waiting and blocked live states', () => {
    const store = createTestStore()
    store.setState({
      tabsByWorktree: {
        'wt-1': [makeTab({ id: 'tab-1', worktreeId: 'wt-1' })]
      }
    } as Partial<AppState>)
    const launchToken = 'launch-token-1'
    const launchConfig = {
      agentCommand: "codex '--model' 'gpt-5'",
      agentArgs: '--model gpt-5',
      agentEnv: { CODEX_PROFILE: 'captured' }
    }
    const providerSession = { key: 'session_id' as const, id: 'codex-session-1' }

    store.getState().registerAgentLaunchConfig('tab-1:leaf-1', launchConfig, {
      agentType: 'codex',
      launchToken,
      tabId: 'tab-1',
      leafId: 'leaf-1'
    })
    store
      .getState()
      .setAgentStatus(
        'tab-1:leaf-1',
        { state: 'working', prompt: 'first task', agentType: 'codex' },
        'Codex',
        { updatedAt: 10, stateStartedAt: 10 },
        { tabId: 'tab-1', worktreeId: 'wt-1' },
        { providerSession, launchToken }
      )
    store
      .getState()
      .setAgentStatus(
        'tab-1:leaf-1',
        { state: 'waiting', prompt: 'first task', agentType: 'codex' },
        'Codex',
        { updatedAt: 20, stateStartedAt: 20 },
        { tabId: 'tab-1', worktreeId: 'wt-1' },
        { providerSession }
      )
    store
      .getState()
      .setAgentStatus(
        'tab-1:leaf-1',
        { state: 'blocked', prompt: 'first task', agentType: 'codex' },
        'Codex',
        { updatedAt: 30, stateStartedAt: 30 },
        { tabId: 'tab-1', worktreeId: 'wt-1' },
        { providerSession }
      )

    expect(store.getState().agentLaunchConfigByPaneKey['tab-1:leaf-1']?.launchConfig).toEqual(
      launchConfig
    )
    expect(store.getState().sleepingAgentSessionsByPaneKey['tab-1:leaf-1']?.launchConfig).toEqual(
      launchConfig
    )
  })

  it('uses provider session matching to capture launch config without a launch token', () => {
    const store = createTestStore()
    store.setState({
      tabsByWorktree: {
        'wt-1': [makeTab({ id: 'tab-1', worktreeId: 'wt-1' })]
      }
    } as Partial<AppState>)
    const launchToken = 'launch-token-1'
    const launchConfig = {
      agentCommand: "codex '--model' 'gpt-5'",
      agentArgs: '--model gpt-5',
      agentEnv: { CODEX_PROFILE: 'captured' }
    }
    const providerSession = { key: 'session_id' as const, id: 'codex-session-1' }

    store.getState().registerAgentLaunchConfig('tab-1:leaf-1', launchConfig, {
      agentType: 'codex',
      launchToken,
      tabId: 'tab-1',
      leafId: 'leaf-1'
    })
    store
      .getState()
      .setAgentStatus(
        'tab-1:leaf-1',
        { state: 'working', prompt: 'first task', agentType: 'codex' },
        'Codex',
        { updatedAt: 10, stateStartedAt: 10 },
        { tabId: 'tab-1', worktreeId: 'wt-1' },
        { providerSession, launchToken }
      )

    const records = collectSleepingAgentSessionRecordsForWorktree(store.getState(), 'wt-1')
    expect(records['tab-1:leaf-1']?.launchConfig).toEqual(launchConfig)

    store.getState().captureAllSleepingAgentSessions()
    expect(store.getState().sleepingAgentSessionsByPaneKey['tab-1:leaf-1']).toMatchObject({
      origin: 'quit',
      launchConfig
    })
  })

  it('preserves hydrated launch config during live recapture without a registry entry', () => {
    const store = createTestStore()
    store.setState({
      tabsByWorktree: {
        'wt-1': [makeTab({ id: 'tab-1', worktreeId: 'wt-1' })]
      }
    } as Partial<AppState>)
    const providerSession = { key: 'session_id' as const, id: 'codex-session-1' }
    const launchConfig = {
      agentCommand: "codex '--model' 'gpt-5'",
      agentArgs: '--model gpt-5',
      agentEnv: { CODEX_PROFILE: 'captured' }
    }
    store.setState({
      sleepingAgentSessionsByPaneKey: {
        'tab-1:leaf-1': {
          paneKey: 'tab-1:leaf-1',
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          agent: 'codex',
          providerSession,
          prompt: 'first task',
          state: 'working',
          capturedAt: 10,
          updatedAt: 10,
          launchConfig,
          origin: 'live'
        }
      }
    } as Partial<AppState>)
    expect(store.getState().agentLaunchConfigByPaneKey['tab-1:leaf-1']).toBeUndefined()

    store
      .getState()
      .setAgentStatus(
        'tab-1:leaf-1',
        { state: 'working', prompt: 'first task', agentType: 'codex' },
        'Codex',
        { updatedAt: 20, stateStartedAt: 10 },
        { tabId: 'tab-1', worktreeId: 'wt-1' },
        { providerSession }
      )

    expect(store.getState().sleepingAgentSessionsByPaneKey['tab-1:leaf-1']?.launchConfig).toEqual(
      launchConfig
    )
    expect(
      collectSleepingAgentSessionRecordsForWorktree(store.getState(), 'wt-1')['tab-1:leaf-1']
        ?.launchConfig
    ).toEqual(launchConfig)

    store.getState().captureAllSleepingAgentSessions()
    expect(store.getState().sleepingAgentSessionsByPaneKey['tab-1:leaf-1']).toMatchObject({
      origin: 'quit',
      launchConfig
    })
  })

  it('does not reuse a stale pane launch config for a new provider session', () => {
    const store = createTestStore()
    store.setState({
      tabsByWorktree: {
        'wt-1': [makeTab({ id: 'tab-1', worktreeId: 'wt-1' })]
      }
    } as Partial<AppState>)
    const launchToken = 'launch-token-1'

    store.getState().registerAgentLaunchConfig(
      'tab-1:leaf-1',
      {
        agentArgs: '--model gpt-5',
        agentEnv: { CODEX_PROFILE: 'captured' }
      },
      {
        agentType: 'codex',
        launchToken,
        tabId: 'tab-1',
        leafId: 'leaf-1'
      }
    )
    store.getState().setAgentStatus(
      'tab-1:leaf-1',
      {
        state: 'working',
        prompt: 'first task',
        agentType: 'codex'
      },
      'Codex',
      { updatedAt: 10, stateStartedAt: 10 },
      { tabId: 'tab-1', worktreeId: 'wt-1' },
      { providerSession: { key: 'session_id', id: 'codex-session-1' }, launchToken }
    )
    expect(store.getState().agentStatusByPaneKey['tab-1:leaf-1']).not.toHaveProperty('launchConfig')

    store.getState().setAgentStatus(
      'tab-1:leaf-1',
      {
        state: 'working',
        prompt: 'manual follow-up',
        agentType: 'codex'
      },
      'Codex',
      { updatedAt: 20, stateStartedAt: 20 },
      { tabId: 'tab-1', worktreeId: 'wt-1' },
      { providerSession: { key: 'session_id', id: 'codex-session-2' } }
    )

    expect(store.getState().agentStatusByPaneKey['tab-1:leaf-1']?.providerSession).toEqual({
      key: 'session_id',
      id: 'codex-session-2'
    })
    expect(store.getState().agentStatusByPaneKey['tab-1:leaf-1']).not.toHaveProperty('launchConfig')
    expect(
      store.getState().sleepingAgentSessionsByPaneKey['tab-1:leaf-1']?.launchConfig
    ).toBeUndefined()
    expect(store.getState().agentLaunchConfigByPaneKey['tab-1:leaf-1']).toBeUndefined()
  })

  it('does not attach a registered launch config to a different agent identity', () => {
    const store = createTestStore()
    store.setState({
      tabsByWorktree: {
        'wt-1': [makeTab({ id: 'tab-1', worktreeId: 'wt-1' })]
      }
    } as Partial<AppState>)

    store.getState().registerAgentLaunchConfig(
      'tab-1:leaf-1',
      {
        agentArgs: '--model gpt-5',
        agentEnv: { CODEX_PROFILE: 'captured' }
      },
      { agentType: 'codex', tabId: 'tab-1', leafId: 'leaf-1' }
    )
    store.getState().setAgentStatus(
      'tab-1:leaf-1',
      {
        state: 'working',
        prompt: 'manual follow-up',
        agentType: 'claude'
      },
      'Claude',
      { updatedAt: 10, stateStartedAt: 10 },
      { tabId: 'tab-1', worktreeId: 'wt-1' },
      { providerSession: { key: 'session_id', id: 'claude-session-1' } }
    )

    expect(store.getState().agentStatusByPaneKey['tab-1:leaf-1']).not.toHaveProperty('launchConfig')
  })

  it('clears a registered launch config for terminal reuse', () => {
    const store = createTestStore()
    store.getState().registerAgentLaunchConfig('tab-1:leaf-1', {
      agentArgs: '--model gpt-5',
      agentEnv: { CODEX_PROFILE: 'captured' }
    })

    store.getState().clearAgentLaunchConfig('tab-1:leaf-1')

    expect(store.getState().agentLaunchConfigByPaneKey['tab-1:leaf-1']).toBeUndefined()
  })

  it('drops a launch-config-only registry entry before the first hook status', () => {
    const store = createTestStore()
    store.getState().registerAgentLaunchConfig(
      'tab-1:leaf-1',
      {
        agentArgs: '--model gpt-5',
        agentEnv: { CODEX_PROFILE: 'captured' }
      },
      { agentType: 'codex', launchToken: 'launch-token-1', tabId: 'tab-1', leafId: 'leaf-1' }
    )

    store.getState().dropAgentStatus('tab-1:leaf-1')

    expect(store.getState().agentLaunchConfigByPaneKey['tab-1:leaf-1']).toBeUndefined()
  })

  it('scrubs launch config registry entries when worktree agent status is dropped', () => {
    const store = createTestStore()
    store.setState({
      tabsByWorktree: {
        'wt-1': [makeTab({ id: 'tab-1', worktreeId: 'wt-1' })]
      }
    } as Partial<AppState>)
    store.getState().registerAgentLaunchConfig(
      'tab-1:leaf-1',
      {
        agentArgs: '--model gpt-5',
        agentEnv: { CODEX_PROFILE: 'captured' }
      },
      { agentType: 'codex', tabId: 'tab-1', leafId: 'leaf-1' }
    )

    store.getState().dropAgentStatusByWorktree('wt-1')

    expect(store.getState().agentLaunchConfigByPaneKey['tab-1:leaf-1']).toBeUndefined()
  })

  it('clears launch config registry entries when sleeping sessions are cleared by worktree', () => {
    const store = createTestStore()
    store.setState({
      tabsByWorktree: {
        'wt-1': [makeTab({ id: 'tab-1', worktreeId: 'wt-1' })],
        'wt-2': [makeTab({ id: 'tab-2', worktreeId: 'wt-2' })]
      }
    } as Partial<AppState>)

    store
      .getState()
      .setAgentStatus(
        'tab-1:leaf-1',
        { state: 'working', prompt: 'first task', agentType: 'codex' },
        'Codex',
        { updatedAt: 10, stateStartedAt: 10 },
        { tabId: 'tab-1', worktreeId: 'wt-1' },
        { providerSession: { key: 'session_id', id: 'codex-session-1' } }
      )
    store
      .getState()
      .setAgentStatus(
        'tab-2:leaf-2',
        { state: 'working', prompt: 'second task', agentType: 'codex' },
        'Codex',
        { updatedAt: 10, stateStartedAt: 10 },
        { tabId: 'tab-2', worktreeId: 'wt-2' },
        { providerSession: { key: 'session_id', id: 'codex-session-2' } }
      )
    store.getState().registerAgentLaunchConfig('tab-1:leaf-1', {
      agentArgs: '--model gpt-5',
      agentEnv: { CODEX_PROFILE: 'first' }
    })
    store.getState().registerAgentLaunchConfig('tab-2:leaf-2', {
      agentArgs: '--model gpt-5',
      agentEnv: { CODEX_PROFILE: 'second' }
    })

    store.getState().clearSleepingAgentSessionsByWorktree('wt-1')

    expect(store.getState().sleepingAgentSessionsByPaneKey['tab-1:leaf-1']).toBeUndefined()
    expect(store.getState().agentLaunchConfigByPaneKey['tab-1:leaf-1']).toBeUndefined()
    expect(store.getState().sleepingAgentSessionsByPaneKey['tab-2:leaf-2']).toBeDefined()
    expect(store.getState().agentLaunchConfigByPaneKey['tab-2:leaf-2']?.launchConfig).toEqual({
      agentArgs: '--model gpt-5',
      agentEnv: { CODEX_PROFILE: 'second' }
    })
  })

  it('clears launch config registry entries when invalid sleeping sessions are pruned', () => {
    const store = createTestStore()
    store.setState({
      tabsByWorktree: {
        'wt-1': [makeTab({ id: 'tab-1', worktreeId: 'wt-1' })],
        'wt-2': [makeTab({ id: 'tab-2', worktreeId: 'wt-2' })]
      }
    } as Partial<AppState>)

    store
      .getState()
      .setAgentStatus(
        'tab-1:leaf-1',
        { state: 'working', prompt: 'first task', agentType: 'codex' },
        'Codex',
        { updatedAt: 10, stateStartedAt: 10 },
        { tabId: 'tab-1', worktreeId: 'wt-1' },
        { providerSession: { key: 'session_id', id: 'codex-session-1' } }
      )
    store
      .getState()
      .setAgentStatus(
        'tab-2:leaf-2',
        { state: 'working', prompt: 'second task', agentType: 'codex' },
        'Codex',
        { updatedAt: 10, stateStartedAt: 10 },
        { tabId: 'tab-2', worktreeId: 'wt-2' },
        { providerSession: { key: 'session_id', id: 'codex-session-2' } }
      )
    store.getState().registerAgentLaunchConfig('tab-1:leaf-1', {
      agentArgs: '--model gpt-5',
      agentEnv: { CODEX_PROFILE: 'first' }
    })
    store.getState().registerAgentLaunchConfig('tab-2:leaf-2', {
      agentArgs: '--model gpt-5',
      agentEnv: { CODEX_PROFILE: 'second' }
    })

    store.getState().pruneSleepingAgentSessions(new Set(['wt-2']))

    expect(store.getState().sleepingAgentSessionsByPaneKey['tab-1:leaf-1']).toBeUndefined()
    expect(store.getState().agentLaunchConfigByPaneKey['tab-1:leaf-1']).toBeUndefined()
    expect(store.getState().sleepingAgentSessionsByPaneKey['tab-2:leaf-2']).toBeDefined()
    expect(store.getState().agentLaunchConfigByPaneKey['tab-2:leaf-2']?.launchConfig).toEqual({
      agentArgs: '--model gpt-5',
      agentEnv: { CODEX_PROFILE: 'second' }
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
    expect(store.getState().agentLaunchConfigByPaneKey['tab-1:leaf-1']).toBeUndefined()
  })

  it('does not reuse launch config from a completed same-pane agent', () => {
    const store = createTestStore()
    store.setState({
      tabsByWorktree: {
        'wt-1': [makeTab({ id: 'tab-1', worktreeId: 'wt-1' })]
      }
    } as Partial<AppState>)
    const launchToken = 'launch-token-1'

    store.getState().setAgentStatus(
      'tab-1:leaf-1',
      { state: 'working', prompt: 'first task', agentType: 'codex' },
      'Codex',
      { updatedAt: 10, stateStartedAt: 10 },
      { tabId: 'tab-1', worktreeId: 'wt-1' },
      {
        providerSession: { key: 'session_id', id: 'codex-session-1' },
        launchToken,
        launchConfig: {
          agentArgs: '--model gpt-5',
          agentEnv: { CODEX_PROFILE: 'captured' }
        }
      }
    )
    store
      .getState()
      .setAgentStatus(
        'tab-1:leaf-1',
        { state: 'done', prompt: 'first task', agentType: 'codex' },
        'Codex',
        { updatedAt: 20, stateStartedAt: 10 },
        { tabId: 'tab-1', worktreeId: 'wt-1' },
        { providerSession: { key: 'session_id', id: 'codex-session-1' }, launchToken }
      )

    store
      .getState()
      .setAgentStatus(
        'tab-1:leaf-1',
        { state: 'working', prompt: 'manual task', agentType: 'codex' },
        'Codex',
        { updatedAt: 30, stateStartedAt: 30 },
        { tabId: 'tab-1', worktreeId: 'wt-1' },
        { launchToken }
      )

    const entry = store.getState().agentStatusByPaneKey['tab-1:leaf-1']
    expect(entry?.providerSession).toBeUndefined()
    expect(entry).not.toHaveProperty('launchConfig')
    expect(
      store.getState().sleepingAgentSessionsByPaneKey['tab-1:leaf-1']?.launchConfig
    ).toBeUndefined()
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

  it('skips done agents — there is no turn left to resume', () => {
    const store = createTestStore()
    const entry = makeAgentEntry({
      paneKey: 'tab-1:leaf-1',
      worktreeId: 'wt-1',
      sessionId: 'sess-1'
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
