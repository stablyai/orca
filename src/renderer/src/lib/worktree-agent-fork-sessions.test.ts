import { describe, expect, it } from 'vitest'
import type {
  SleepingAgentLaunchConfig,
  SleepingAgentSessionRecord
} from '../../../shared/agent-session-resume'
import type { AgentStatusEntry } from '../../../shared/agent-status-types'
import type { TerminalTab } from '../../../shared/terminal-tab-types'
import type {
  AgentLaunchConfigRegistryEntry,
  RetainedAgentEntry
} from '@/store/slices/agent-status-contract'
import {
  listForkableAgentSessions,
  type ForkableAgentSessionsState
} from './worktree-agent-fork-sessions'

function emptyState(): ForkableAgentSessionsState {
  return {
    agentStatusByPaneKey: {},
    retainedAgentsByPaneKey: {},
    sleepingAgentSessionsByPaneKey: {},
    agentLaunchConfigByPaneKey: {}
  }
}

function liveEntry(paneKey: string, overrides: Partial<AgentStatusEntry> = {}): AgentStatusEntry {
  return {
    state: 'working',
    prompt: '',
    updatedAt: 100,
    stateStartedAt: 100,
    stateHistory: [],
    agentType: 'claude',
    paneKey,
    worktreeId: 'wt-1',
    terminalTitle: 'Claude',
    providerSession: { key: 'session_id', id: `sess-${paneKey}` },
    ...overrides
  }
}

function terminalTab(id: string, worktreeId: string): TerminalTab {
  return {
    id,
    ptyId: null,
    worktreeId,
    title: 'Codex',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
}

function retainedEntry(
  paneKey: string,
  overrides: Partial<AgentStatusEntry> = {}
): RetainedAgentEntry {
  const entry = liveEntry(paneKey, { state: 'done', agentType: 'codex', ...overrides })
  return {
    entry,
    worktreeId: entry.worktreeId ?? 'wt-1',
    tab: terminalTab(paneKey.split(':')[0] ?? paneKey, entry.worktreeId ?? 'wt-1'),
    agentType: entry.agentType ?? 'codex',
    startedAt: entry.stateStartedAt
  }
}

function sleepingRecord(
  paneKey: string,
  overrides: Partial<SleepingAgentSessionRecord> = {}
): SleepingAgentSessionRecord {
  return {
    paneKey,
    worktreeId: 'wt-1',
    agent: 'claude',
    providerSession: { key: 'session_id', id: `sess-${paneKey}` },
    prompt: '',
    state: 'done',
    capturedAt: 100,
    updatedAt: 100,
    terminalTitle: 'Sleeping Claude',
    ...overrides
  }
}

function launchConfig(agentArgs: string): SleepingAgentLaunchConfig {
  return { agentArgs, agentEnv: { ORCA_TEST: agentArgs } }
}

function registryEntry(config: SleepingAgentLaunchConfig): AgentLaunchConfigRegistryEntry {
  return { launchConfig: config, registeredAt: 1, identity: { agentType: 'claude' } }
}

describe('listForkableAgentSessions', () => {
  it('lists live native-fork sessions of the worktree, newest first', () => {
    const state = emptyState()
    state.agentStatusByPaneKey = {
      'tab-1:a': liveEntry('tab-1:a', { updatedAt: 100 }),
      'tab-2:b': liveEntry('tab-2:b', { updatedAt: 200, terminalTitle: 'Newer' })
    }

    const sessions = listForkableAgentSessions(state, 'wt-1')

    expect(sessions.map((session) => session.lastActiveAt)).toEqual([200, 100])
    expect(sessions[0]).toEqual({
      providerSessionId: 'sess-tab-2:b',
      paneKey: 'tab-2:b',
      agent: 'claude',
      providerSession: { key: 'session_id', id: 'sess-tab-2:b' },
      launchConfig: null,
      title: 'Newer',
      lastActiveAt: 200,
      live: true
    })
  })

  it('ignores other worktrees, agents without native fork, and sessions without a provider id', () => {
    const state = emptyState()
    state.agentStatusByPaneKey = {
      'tab-1:gemini': liveEntry('tab-1:gemini', { agentType: 'gemini' }),
      'tab-1:other-wt': liveEntry('tab-1:other-wt', { worktreeId: 'wt-2' }),
      'tab-1:no-session': liveEntry('tab-1:no-session', { providerSession: undefined }),
      'tab-1:conversation': liveEntry('tab-1:conversation', {
        providerSession: { key: 'conversation_id', id: 'conv-1' }
      }),
      'tab-1:blank': liveEntry('tab-1:blank', {
        providerSession: { key: 'session_id', id: '   ' }
      })
    }
    state.retainedAgentsByPaneKey = {
      'tab-2:other-wt': retainedEntry('tab-2:other-wt', { worktreeId: 'wt-2' })
    }
    state.sleepingAgentSessionsByPaneKey = {
      'tab-3:gemini': sleepingRecord('tab-3:gemini', { agent: 'gemini' })
    }

    expect(listForkableAgentSessions(state, 'wt-1')).toEqual([])
    expect(listForkableAgentSessions(emptyState(), 'wt-1')).toEqual([])
  })

  it('ignores restored-unconfirmed live entries', () => {
    const state = emptyState()
    state.agentStatusByPaneKey = {
      'tab-1:a': liveEntry('tab-1:a', { restoredUnconfirmed: true })
    }

    expect(listForkableAgentSessions(state, 'wt-1')).toEqual([])
    state.agentStatusByPaneKey = { 'tab-1:a': liveEntry('tab-1:a') }
    expect(listForkableAgentSessions(state, 'wt-1')).toHaveLength(1)
  })

  it('includes retained and sleeping sessions and dedupes by provider session id preferring live', () => {
    const shared = { key: 'session_id', id: 'sess-shared' } as const
    const state = emptyState()
    state.agentStatusByPaneKey = {
      'tab-1:live': liveEntry('tab-1:live', { updatedAt: 50, providerSession: shared })
    }
    state.sleepingAgentSessionsByPaneKey = {
      'tab-2:sleeping': sleepingRecord('tab-2:sleeping', {
        updatedAt: 90,
        providerSession: shared
      })
    }
    state.retainedAgentsByPaneKey = {
      'tab-3:retained': retainedEntry('tab-3:retained', { updatedAt: 70 })
    }

    const sessions = listForkableAgentSessions(state, 'wt-1')

    expect(sessions.map((session) => session.providerSessionId)).toEqual([
      'sess-tab-3:retained',
      'sess-shared'
    ])
    expect(sessions[1]).toMatchObject({ paneKey: 'tab-1:live', live: true, lastActiveAt: 50 })
    expect(sessions[0]).toMatchObject({ agent: 'codex', live: false, lastActiveAt: 70 })
  })

  it('takes the launch config from the sleeping record, else from the launch registry', () => {
    const sleepingConfig = launchConfig('--sleeping')
    const registryConfig = launchConfig('--registry')
    const state = emptyState()
    state.sleepingAgentSessionsByPaneKey = {
      'tab-1:sleeping': sleepingRecord('tab-1:sleeping', {
        updatedAt: 300,
        launchConfig: sleepingConfig
      })
    }
    state.agentStatusByPaneKey = {
      'tab-2:live': liveEntry('tab-2:live', { updatedAt: 200 }),
      'tab-3:bare': liveEntry('tab-3:bare', { updatedAt: 100 })
    }
    state.agentLaunchConfigByPaneKey = {
      'tab-1:sleeping': registryEntry(registryConfig),
      'tab-2:live': registryEntry(registryConfig)
    }

    const sessions = listForkableAgentSessions(state, 'wt-1')

    expect(sessions.map((session) => session.launchConfig)).toEqual([
      sleepingConfig,
      registryConfig,
      null
    ])
  })

  it("ignores another agent's launch config left on the same pane", () => {
    const codexConfig = { agentArgs: '', agentEnv: { CODEX_HOME: '/acct/codex' } }
    const state = emptyState()
    state.agentStatusByPaneKey = {
      'tab-1:leaf': liveEntry('tab-1:leaf', { updatedAt: 200 })
    }
    state.sleepingAgentSessionsByPaneKey = {
      'tab-1:leaf': sleepingRecord('tab-1:leaf', {
        agent: 'codex',
        providerSession: { key: 'session_id', id: 'thread-old' },
        updatedAt: 100,
        launchConfig: codexConfig
      })
    }
    state.agentLaunchConfigByPaneKey = {
      'tab-1:leaf': {
        launchConfig: codexConfig,
        registeredAt: 1,
        identity: { agentType: 'codex' }
      }
    }

    const sessions = listForkableAgentSessions(state, 'wt-1')

    expect(sessions).toEqual([
      expect.objectContaining({ agent: 'claude', launchConfig: null }),
      expect.objectContaining({ agent: 'codex', launchConfig: codexConfig })
    ])
  })

  it('ignores a launch config registered for a different provider session', () => {
    const state = emptyState()
    state.agentStatusByPaneKey = { 'tab-1:leaf': liveEntry('tab-1:leaf') }
    state.agentLaunchConfigByPaneKey = {
      'tab-1:leaf': {
        launchConfig: launchConfig('--other-session'),
        registeredAt: 1,
        identity: { agentType: 'claude', providerSession: { key: 'session_id', id: 'sess-old' } }
      }
    }

    const [session] = listForkableAgentSessions(state, 'wt-1')

    expect(session).toMatchObject({ paneKey: 'tab-1:leaf', launchConfig: null })
  })

  it('skips a sleeping record of another session and uses a matching registry entry', () => {
    const registryConfig = launchConfig('--registry')
    const state = emptyState()
    state.agentStatusByPaneKey = { 'tab-1:leaf': liveEntry('tab-1:leaf') }
    state.sleepingAgentSessionsByPaneKey = {
      'tab-1:leaf': sleepingRecord('tab-1:leaf', {
        worktreeId: 'wt-other',
        providerSession: { key: 'session_id', id: 'sess-old' },
        launchConfig: launchConfig('--old-session')
      })
    }
    state.agentLaunchConfigByPaneKey = {
      'tab-1:leaf': {
        launchConfig: registryConfig,
        registeredAt: 1,
        identity: {
          agentType: 'claude',
          providerSession: { key: 'session_id', id: 'sess-tab-1:leaf' }
        }
      }
    }

    const [session] = listForkableAgentSessions(state, 'wt-1')

    expect(session).toMatchObject({ paneKey: 'tab-1:leaf', launchConfig: registryConfig })
  })
})
