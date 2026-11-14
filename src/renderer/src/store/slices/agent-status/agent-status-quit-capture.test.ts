import { describe, expect, it } from 'vitest'

import type { AppState } from '../../types'
import './agent-status'

import { createTestStore } from '../../testing/app-store-test-fixture'
import { makeTab } from '../../terminals/testing/terminal-tab.test-fixture'

describe('captureAllSleepingAgentSessions', () => {
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

  it('does not let a periodic checkpoint supersede a confirmed quit record', () => {
    const store = createTestStore()
    store.setState({
      tabsByWorktree: {
        'wt-1': [makeTab({ id: 'tab-1', worktreeId: 'wt-1' })]
      }
    } as Partial<AppState>)
    const providerSession = { key: 'session_id' as const, id: 'codex-session-1' }
    store
      .getState()
      .setAgentStatus(
        'tab-1:leaf-1',
        { state: 'working', prompt: 'first task', agentType: 'codex' },
        'Codex',
        { updatedAt: 10, stateStartedAt: 10 },
        { tabId: 'tab-1', worktreeId: 'wt-1' },
        { providerSession }
      )

    store.getState().captureAllSleepingAgentSessions('quit')
    store.getState().captureAllSleepingAgentSessions('periodic')
    const quitRecord = store.getState().sleepingAgentSessionsByPaneKey['tab-1:leaf-1']

    expect(quitRecord).toMatchObject({ origin: 'quit', providerSession })

    store
      .getState()
      .setAgentStatus(
        'tab-1:leaf-1',
        { state: 'working', prompt: 'new task', agentType: 'codex' },
        'Codex',
        { updatedAt: 20, stateStartedAt: 20 },
        { tabId: 'tab-1', worktreeId: 'wt-1' },
        { providerSession: { key: 'session_id', id: 'codex-session-2' } }
      )

    expect(store.getState().sleepingAgentSessionsByPaneKey['tab-1:leaf-1']).toMatchObject({
      origin: 'live',
      providerSession: { key: 'session_id', id: 'codex-session-2' }
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

    store.getState().captureAllSleepingAgentSessions('quit')
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

    expect(store.getState().agentLaunchConfigByPaneKey['tab-2:leaf-2']?.launchConfig).toEqual({
      agentArgs: '--model gpt-5',
      agentEnv: { CODEX_PROFILE: 'second' }
    })
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
})
