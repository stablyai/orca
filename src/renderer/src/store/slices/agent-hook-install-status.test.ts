import { describe, expect, it } from 'vitest'
import { createTestStore } from './store-test-helpers'
import type { AgentHookInstallStatus } from '../../../../shared/agent-hook-types'

function status(
  agent: AgentHookInstallStatus['agent'],
  state: AgentHookInstallStatus['state']
): AgentHookInstallStatus {
  return {
    agent,
    state,
    configPath: '/home/user/.claude/settings.json',
    managedHooksPresent: state === 'installed',
    detail: null
  }
}

describe('agentHookInstallStatusSlice', () => {
  it('starts empty so consumers cannot mistake "unread" for "not installed"', () => {
    expect(createTestStore().getState().agentHookInstallStateByTarget).toEqual({})
  })

  it('indexes install state by agent', () => {
    const store = createTestStore()

    store
      .getState()
      .setAgentHookInstallStatuses([
        status('claude', 'not_installed'),
        status('codex', 'installed')
      ])

    expect(store.getState().agentHookInstallStateByTarget).toEqual({
      claude: 'not_installed',
      codex: 'installed'
    })
  })

  it('keeps object identity when the snapshot is unchanged', () => {
    const store = createTestStore()
    store.getState().setAgentHookInstallStatuses([status('claude', 'installed')])
    const first = store.getState().agentHookInstallStateByTarget

    store.getState().setAgentHookInstallStatuses([status('claude', 'installed')])

    // Why: this refreshes on a 30s timer; a new identity per tick would
    // re-render every worktree dot in the sidebar for no change.
    expect(store.getState().agentHookInstallStateByTarget).toBe(first)
  })

  it('publishes a new identity when an agent changes state', () => {
    const store = createTestStore()
    store.getState().setAgentHookInstallStatuses([status('claude', 'installed')])
    const first = store.getState().agentHookInstallStateByTarget

    store.getState().setAgentHookInstallStatuses([status('claude', 'not_installed')])

    expect(store.getState().agentHookInstallStateByTarget).not.toBe(first)
    expect(store.getState().agentHookInstallStateByTarget.claude).toBe('not_installed')
  })

  it('drops agents missing from a newer snapshot', () => {
    const store = createTestStore()
    store
      .getState()
      .setAgentHookInstallStatuses([status('claude', 'installed'), status('codex', 'installed')])

    store.getState().setAgentHookInstallStatuses([status('claude', 'installed')])

    expect(store.getState().agentHookInstallStateByTarget).toEqual({
      claude: 'installed'
    })
  })
})
