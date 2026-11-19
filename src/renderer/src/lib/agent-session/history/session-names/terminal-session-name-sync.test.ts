// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import type { AppState } from '@/store/types'
import type { AgentStatusEntry } from '../../../../../../shared/agent-status/contracts/agent-status-types'
import { acceptedAgentStatuses } from '@/store/slices/agent-status/status-ownership/accepted-agent-statuses'
import {
  agentSessionBindingsChanged,
  startTerminalSessionNameSync,
  terminalTabNamesChanged
} from './terminal-session-name-sync'
import { resetTerminalSessionNameRecordingForTest } from './terminal-session-name-recording'
import {
  getSavedTerminalSessionName,
  resetTerminalSessionNamesForTest
} from './terminal-session-names'
import {
  WORKTREE_ID,
  makeTerminalNamesState,
  withHeartbeat
} from './terminal-session-names-test-fixture'

function withTabTitle(state: AppState, patch: { title?: string; customTitle?: string | null }) {
  return {
    ...state,
    tabsByWorktree: {
      ...state.tabsByWorktree,
      [WORKTREE_ID]: state.tabsByWorktree[WORKTREE_ID].map((tab) => ({
        ...tab,
        ...patch
      }))
    }
  }
}

function harness(initial: AppState) {
  let state = initial
  const listeners = new Set<(next: AppState, previous: AppState) => void>()
  const pending: (() => void)[] = []
  const stop = startTerminalSessionNameSync({
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    scheduleReconcile: (callback) => {
      pending.push(callback)
      return () => pending.splice(pending.indexOf(callback), 1)
    }
  })
  return {
    pending,
    set(next: AppState) {
      const previous = state
      state = next
      for (const listener of listeners) {
        listener(state, previous)
      }
    },
    get state() {
      return state
    },
    flush() {
      while (pending.length > 0) {
        pending.shift()!()
      }
    },
    stop
  }
}

describe('terminal session name sync', () => {
  beforeEach(() => {
    localStorage.clear()
    resetTerminalSessionNamesForTest()
    resetTerminalSessionNameRecordingForTest()
  })

  it('looks once at mount, then saves a name that arrives in a host snapshot', () => {
    const sync = harness(makeTerminalNamesState([{ id: 'tab-1', sessionId: 's1' }]))
    expect(sync.pending).toHaveLength(1)
    sync.flush()
    sync.set(withTabTitle(sync.state, { customTitle: 'From phone' }))
    expect(sync.pending).toHaveLength(1)
    sync.flush()
    expect(getSavedTerminalSessionName('local', 'claude', 's1')).toBe('From phone')
    sync.stop()
  })

  it.each(['claude', 'opencode'] as const)(
    'ignores terminal title churn and %s status heartbeats',
    (agent) => {
      const sync = harness(
        makeTerminalNamesState([{ id: 'tab-1', sessionId: 's1', agent, customTitle: 'N' }])
      )
      sync.flush()
      for (let index = 0; index < 20; index++) {
        sync.set(withTabTitle(sync.state, { title: `⠋ working ${index}` }))
        sync.set(withHeartbeat(sync.state))
      }
      expect(sync.pending).toHaveLength(0)
      sync.stop()
    }
  )

  it('wakes when a session id appears for any agent, not on heartbeats', () => {
    const before = makeTerminalNamesState([{ id: 'tab-1', agent: 'opencode', sessionId: 'oc1' }])
    expect(agentSessionBindingsChanged(withHeartbeat(before), before)).toBe(false)
    const [key, current] = before.agentStatusByPaneKey.entries().next().value!
    const draft = before.agentStatusByPaneKey.replace([
      [key, { ...current, providerSession: { key: 'session_id', id: 'oc2' } }]
    ])
    draft.prepare()()
    expect(agentSessionBindingsChanged({ ...before, agentStatusByPaneKey: draft }, before)).toBe(
      true
    )
  })

  it('compares only tab ids and names', () => {
    const state = makeTerminalNamesState([{ id: 'tab-1', customTitle: 'A' }])
    expect(terminalTabNamesChanged(withTabTitle(state, { title: 'spinner' }), state)).toBe(false)
    expect(terminalTabNamesChanged(withTabTitle(state, { customTitle: 'B' }), state)).toBe(true)
    expect(
      terminalTabNamesChanged(makeTerminalNamesState([{ id: 'tab-2', customTitle: 'A' }]), state)
    ).toBe(true)
  })

  it('retries tabs skipped for an unknown host when owner facts change', () => {
    const known = makeTerminalNamesState([{ id: 'tab-1', sessionId: 's1', customTitle: 'N' }])
    const unknown = {
      ...known,
      activeWorktreeId: null,
      activeWorkspaceExecutionHostId: null,
      getKnownWorktreeById: () => undefined
    }
    const sync = harness(unknown)
    sync.flush()
    expect(getSavedTerminalSessionName('local', 'claude', 's1')).toBeNull()
    sync.set({
      ...known,
      runtimeEnvironments: [...(known.runtimeEnvironments ?? [])]
    })
    expect(sync.pending).toHaveLength(1)
    sync.flush()
    expect(getSavedTerminalSessionName('local', 'claude', 's1')).toBe('N')
    sync.stop()
  })
})

describe('agent status session revision', () => {
  const entry = (sessionId: string, updatedAt = 1): [string, AgentStatusEntry] => {
    const [key, value] = makeTerminalNamesState([{ id: 'tab-1', sessionId, agent: 'gemini' }])
      .agentStatusByPaneKey.entries()
      .next().value!
    return [key, { ...value, updatedAt }]
  }

  it('counts session changes for every agent, not heartbeats, and survives capture', () => {
    const statuses = acceptedAgentStatuses([entry('g1')])
    const heartbeat = statuses.replace([entry('g1', 2)])
    heartbeat.prepare()()
    expect(heartbeat.sessionRevision).toBe(statuses.sessionRevision)
    expect(heartbeat.titleRevision).toBe(statuses.titleRevision)

    const changed = heartbeat.replace([entry('g2', 3)])
    changed.prepare()()
    expect(changed.sessionRevision).toBe(statuses.sessionRevision + 1)
    // Gemini is not a provider-title agent, so the title revision stays put.
    expect(changed.titleRevision).toBe(statuses.titleRevision)
    expect(changed.capture().sessionRevision).toBe(changed.sessionRevision)
    expect(changed.refresh([]).sessionRevision).toBe(changed.sessionRevision)
  })
})
