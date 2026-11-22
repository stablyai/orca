// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import type { AppState } from '@/store/types'
import type { AgentStatusEntry } from '../../../../../../shared/agent-status/contracts/agent-status-types'
import { acceptedAgentStatuses } from '@/store/slices/agent-status/status-ownership/accepted-agent-statuses'
import {
  startTerminalSessionNameSync,
  terminalTabNamesChanged,
  unsettledTerminalTabsClosed
} from './terminal-session-name-sync'
import {
  recordTerminalTabRename,
  resetTerminalSessionNameRecordingForTest
} from './terminal-session-name-recording'
import { reconcileTerminalSessionNames } from './terminal-session-name-pass'
import { LOCAL_TAB_NAME_WRITE_GRACE_MS } from './terminal-session-name-state'
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

function harness(initial: AppState, clock?: { now: number; timers: (() => void)[] }) {
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
    },
    ...(clock
      ? {
          now: () => clock.now,
          setTimer: (callback: () => void) => {
            clock.timers.push(callback)
            return setTimeout(() => {}, 0)
          },
          clearTimer: () => {}
        }
      : {})
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

  it('records a new OpenCode session while ignoring spinner titles and heartbeats', () => {
    const before = makeTerminalNamesState([
      { id: 'tab-1', agent: 'opencode', sessionId: 'oc1', customTitle: 'Review' }
    ])
    const sync = harness(before)
    sync.flush()
    sync.set(withTabTitle(sync.state, { title: '⠋ working' }))
    sync.set(withHeartbeat(sync.state))
    expect(sync.pending).toHaveLength(0)
    const [key, current] = sync.state.agentStatusByPaneKey.entries().next().value!
    const draft = sync.state.agentStatusByPaneKey.replace([
      [key, { ...current, providerSession: { key: 'session_id', id: 'oc2' } }]
    ])
    draft.prepare()()
    sync.set({ ...sync.state, agentStatusByPaneKey: draft })
    sync.flush()
    expect(getSavedTerminalSessionName('local', 'opencode', 'oc2')).toBe('Review')
    sync.stop()
  })

  it('notices a replacement tab even when its name is unchanged', () => {
    const state = makeTerminalNamesState([{ id: 'tab-1', customTitle: 'A' }])
    expect(
      terminalTabNamesChanged(makeTerminalNamesState([{ id: 'tab-2', customTitle: 'A' }]), state)
    ).toBe(true)
  })

  it('looks again when the grace window ends, so a clear made elsewhere is not missed', () => {
    const timers: (() => void)[] = []
    const clock = { now: 1_000_000, timers }
    const named = makeTerminalNamesState([{ id: 'tab-1', sessionId: 's1', customTitle: 'Mine' }])
    recordTerminalTabRename(named, 'tab-1', 'Mine', { now: clock.now })
    const sync = harness(named, clock)
    sync.flush()
    expect(getSavedTerminalSessionName('local', 'claude', 's1')).toBe('Mine')
    // A phone clears the name inside the window; the pass holds back and arms a recheck.
    sync.set(withTabTitle(sync.state, { customTitle: null }))
    sync.flush()
    expect(getSavedTerminalSessionName('local', 'claude', 's1')).toBe('Mine')
    expect(clock.timers).toHaveLength(1)
    clock.now += LOCAL_TAB_NAME_WRITE_GRACE_MS
    clock.timers.shift()!()
    sync.flush()
    expect(getSavedTerminalSessionName('local', 'claude', 's1')).toBeNull()
    sync.stop()
  })

  it('keeps a name from another client when the tab closes before the waiting pass', () => {
    const sync = harness(makeTerminalNamesState([{ id: 'tab-1', sessionId: 's1' }]))
    sync.flush()
    sync.set(withTabTitle(sync.state, { customTitle: 'From phone' }))
    expect(sync.pending).toHaveLength(1)
    // The tab closes before the waiting pass runs.
    sync.set(makeTerminalNamesState([]))
    expect(getSavedTerminalSessionName('local', 'claude', 's1')).toBe('From phone')
    sync.stop()
  })

  it('settles on close only for running sessions whose name or binding the last pass missed', () => {
    const settled = makeTerminalNamesState([
      { id: 'tab-1', sessionId: 's1', customTitle: 'A' },
      { id: 'tab-2', sessionId: 's2' },
      { id: 'shell', customTitle: 'Named shell' }
    ])
    reconcileTerminalSessionNames(settled, 10_000_000_000_000)
    const none = makeTerminalNamesState([])
    // A bulk close of tabs a pass already saw, and of named tabs with no agent, needs nothing.
    expect(unsettledTerminalTabsClosed(none, settled).size).toBe(0)
    // A name that arrived after the pass does.
    expect(
      unsettledTerminalTabsClosed(none, withTabTitle(settled, { customTitle: 'B' })).size
    ).toBeGreaterThan(0)
    // So does a new session started in a tab the pass saw.
    const switched = makeTerminalNamesState([{ id: 'tab-1', sessionId: 's9', customTitle: 'A' }])
    expect(unsettledTerminalTabsClosed(none, switched)).toEqual(new Set(['tab-1']))
  })

  it('keeps a name re-applied from another client after a local clear when the tab closes mid-wait', () => {
    const timers: (() => void)[] = []
    const clock = { now: 1_000_000, timers }
    const named = makeTerminalNamesState([{ id: 'tab-1', sessionId: 's1', customTitle: 'A' }])
    const sync = harness(named, clock)
    sync.flush()
    expect(getSavedTerminalSessionName('local', 'claude', 's1')).toBe('A')
    recordTerminalTabRename(named, 'tab-1', null, { now: clock.now })
    sync.set(makeTerminalNamesState([{ id: 'tab-1', sessionId: 's1' }]))
    sync.flush()
    clock.now += LOCAL_TAB_NAME_WRITE_GRACE_MS * 4
    sync.set(makeTerminalNamesState([{ id: 'tab-1', sessionId: 's1', customTitle: 'A' }]))
    sync.set(makeTerminalNamesState([]))
    expect(getSavedTerminalSessionName('local', 'claude', 's1')).toBe('A')
    sync.stop()
  })

  it("settling closing tabs leaves a surviving tab's pending rename for the waiting pass", () => {
    const sync = harness(
      makeTerminalNamesState([
        { id: 'tab-a', sessionId: 's1', customTitle: 'Build' },
        { id: 'tab-b', sessionId: 's1', customTitle: 'Build' },
        { id: 'tab-c', sessionId: 's3' }
      ])
    )
    sync.flush()
    expect(getSavedTerminalSessionName('local', 'claude', 's1')).toBe('Build')
    // tab-b is renamed and tab-c gets a name, then tab-a (the owner) and tab-c close.
    sync.set(
      makeTerminalNamesState([
        { id: 'tab-a', sessionId: 's1', customTitle: 'Build' },
        { id: 'tab-b', sessionId: 's1', customTitle: 'Review' },
        { id: 'tab-c', sessionId: 's3', customTitle: 'Notes' }
      ])
    )
    sync.set(makeTerminalNamesState([{ id: 'tab-b', sessionId: 's1', customTitle: 'Review' }]))
    expect(getSavedTerminalSessionName('local', 'claude', 's3')).toBe('Notes')
    sync.flush()
    expect(getSavedTerminalSessionName('local', 'claude', 's1')).toBe('Review')
    sync.stop()
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
