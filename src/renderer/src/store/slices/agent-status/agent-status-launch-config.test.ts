import { describe, expect, it } from 'vitest'
import type { AppState } from '../../types'
import './agent-status'
import { getLaunchConfigForEntry } from './agent-status-launch-config'
import { createTestStore } from '../store-test-helpers'
import { makeTab } from '../store-session-test-harness'

const PANE_KEY = 'tab-1:leaf-1'
const FULL_ACCESS = {
  agentCommand: 'claude',
  agentArgs: '--dangerously-skip-permissions',
  agentEnv: {}
}

function storeWithRegisteredRecipe(launchToken: string) {
  const store = createTestStore()
  store.setState({
    tabsByWorktree: { 'wt-1': [makeTab({ id: 'tab-1', worktreeId: 'wt-1' })] }
  } as Partial<AppState>)
  store.getState().registerAgentLaunchConfig(PANE_KEY, FULL_ACCESS, {
    agentType: 'claude',
    launchToken,
    tabId: 'tab-1',
    leafId: 'leaf-1'
  })
  return store
}

function reportHook(store: ReturnType<typeof createTestStore>, launchToken: string | undefined) {
  store
    .getState()
    .setAgentStatus(
      PANE_KEY,
      { state: 'working', prompt: 'work', agentType: 'claude' },
      'Claude',
      { updatedAt: 10, stateStartedAt: 10 },
      { tabId: 'tab-1', worktreeId: 'wt-1' },
      { providerSession: { key: 'session_id', id: 'claude-session-1' }, launchToken }
    )
}

describe('getLaunchConfigForEntry', () => {
  it('returns the token-keyed recipe once a hook row carrying the matching token proved the pane', () => {
    const store = storeWithRegisteredRecipe('token-1')
    reportHook(store, 'token-1')

    const state = store.getState()
    expect(getLaunchConfigForEntry(state, state.agentStatusByPaneKey[PANE_KEY]!)).toEqual(
      FULL_ACCESS
    )
  })

  it('does not expose the recipe before any hook proved the token', () => {
    const store = storeWithRegisteredRecipe('token-1')
    reportHook(store, undefined)

    const state = store.getState()
    expect(getLaunchConfigForEntry(state, state.agentStatusByPaneKey[PANE_KEY]!)).toBeUndefined()
  })

  it('rejects a hook row carrying a mismatched token', () => {
    const store = storeWithRegisteredRecipe('token-1')
    reportHook(store, 'other-token')

    const state = store.getState()
    expect(getLaunchConfigForEntry(state, state.agentStatusByPaneKey[PANE_KEY]!)).toBeUndefined()
  })

  it('stops serving the old recipe when the pane registers a new launch token', () => {
    const store = storeWithRegisteredRecipe('token-1')
    reportHook(store, 'token-1')
    store.getState().registerAgentLaunchConfig(
      PANE_KEY,
      { agentCommand: 'claude', agentArgs: '', agentEnv: {} },
      {
        agentType: 'claude',
        launchToken: 'token-2',
        tabId: 'tab-1',
        leafId: 'leaf-1'
      }
    )

    const state = store.getState()
    expect(getLaunchConfigForEntry(state, state.agentStatusByPaneKey[PANE_KEY]!)).not.toEqual(
      FULL_ACCESS
    )
  })

  it('never serves an unrecorded resume placeholder as a recipe', () => {
    const store = createTestStore()
    store.setState({
      tabsByWorktree: { 'wt-1': [makeTab({ id: 'tab-1', worktreeId: 'wt-1' })] }
    } as Partial<AppState>)
    store
      .getState()
      .registerAgentLaunchConfig(
        PANE_KEY,
        { agentArgs: '', agentEnv: {}, unrecorded: true },
        { agentType: 'claude', launchToken: 'token-1', tabId: 'tab-1', leafId: 'leaf-1' }
      )
    reportHook(store, 'token-1')

    const state = store.getState()
    expect(getLaunchConfigForEntry(state, state.agentStatusByPaneKey[PANE_KEY]!)).toBeUndefined()
    expect(state.sleepingAgentSessionsByPaneKey[PANE_KEY]?.launchConfig).toBeUndefined()
  })
})
