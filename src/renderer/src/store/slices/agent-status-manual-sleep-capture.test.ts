import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SleepingAgentSessionRecord } from '../../../../shared/agent-session-resume'
import {
  AGENT_STATUS_STALE_AFTER_MS,
  type AgentStatusEntry
} from '../../../../shared/agent-status-types'
import type { AppState } from '../types'
import { createTestStore, makeTab } from './store-test-helpers'

const NOW = 1_800_000_000_000

afterEach(() => {
  vi.useRealTimers()
})

function makeAgentEntry(overrides: Partial<AgentStatusEntry> = {}): AgentStatusEntry {
  const paneKey = overrides.paneKey ?? 'tab-1:leaf-1'
  return {
    state: 'working',
    prompt: 'finish the task',
    updatedAt: NOW,
    stateStartedAt: NOW,
    stateHistory: [],
    agentType: 'codex',
    paneKey,
    tabId: paneKey.split(':')[0],
    worktreeId: 'wt-1',
    providerSession: { key: 'session_id', id: `session-${paneKey}` },
    ...overrides
  }
}

function seedTabs(store: ReturnType<typeof createTestStore>): void {
  store.setState({
    tabsByWorktree: {
      'wt-1': [makeTab({ id: 'tab-1', worktreeId: 'wt-1' })]
    }
  } as Partial<AppState>)
}

function makeSleepingRecord(
  overrides: Partial<SleepingAgentSessionRecord> = {}
): SleepingAgentSessionRecord {
  const paneKey = overrides.paneKey ?? 'tab-1:leaf-1'
  return {
    paneKey,
    tabId: paneKey.split(':')[0],
    worktreeId: 'wt-1',
    agent: 'codex',
    providerSession: { key: 'session_id', id: `sleeping-${paneKey}` },
    prompt: 'old prompt',
    state: 'working',
    capturedAt: NOW - AGENT_STATUS_STALE_AFTER_MS - 1,
    updatedAt: NOW - AGENT_STATUS_STALE_AFTER_MS - 1,
    origin: 'live',
    ...overrides
  }
}

describe('manual sleep agent session capture', () => {
  it('captures every resumable live row as a worktree-sleep record keeping its own state', () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    const store = createTestStore()
    seedTabs(store)
    store.setState({
      agentStatusByPaneKey: {
        'tab-1:fresh': makeAgentEntry({ paneKey: 'tab-1:fresh' }),
        'tab-1:stale': makeAgentEntry({
          paneKey: 'tab-1:stale',
          updatedAt: NOW - AGENT_STATUS_STALE_AFTER_MS - 1
        }),
        'tab-1:done': makeAgentEntry({ paneKey: 'tab-1:done', state: 'done' }),
        'tab-1:interrupted': makeAgentEntry({
          paneKey: 'tab-1:interrupted',
          state: 'done',
          interrupted: true
        }),
        'tab-1:post-input': makeAgentEntry({
          paneKey: 'tab-1:post-input',
          updatedAt: NOW - 1_000
        })
      },
      lastTerminalInputAtByPaneKey: { 'tab-1:post-input': NOW }
    } as Partial<AppState>)

    store.getState().captureSleepingAgentSessionsByWorktree('wt-1')

    const records = store.getState().sleepingAgentSessionsByPaneKey
    expect(Object.keys(records).sort()).toEqual([
      'tab-1:done',
      'tab-1:fresh',
      'tab-1:interrupted',
      'tab-1:post-input',
      'tab-1:stale'
    ])
    expect(records['tab-1:fresh']).toMatchObject({
      origin: 'worktree-sleep',
      state: 'working',
      providerSession: { key: 'session_id', id: 'session-tab-1:fresh' }
    })
    expect(records['tab-1:done']).toMatchObject({ origin: 'worktree-sleep', state: 'done' })
    expect(records['tab-1:done'].interrupted).toBeUndefined()
    expect(records['tab-1:interrupted']).toMatchObject({
      origin: 'worktree-sleep',
      state: 'done'
    })
    expect(records['tab-1:interrupted'].interrupted).toBeUndefined()
    expect(records['tab-1:post-input']).toMatchObject({ state: 'working', updatedAt: NOW })
    expect(records['tab-1:stale']).toMatchObject({ state: 'working', updatedAt: NOW })
  })

  it('marks finished panes for tab-open-only restore so a mobile wake cannot respawn them all', () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    const store = createTestStore()
    seedTabs(store)
    const retainedEntry = makeAgentEntry({ paneKey: 'tab-1:retained', state: 'done' })
    store.setState({
      agentStatusByPaneKey: {
        'tab-1:done': makeAgentEntry({ paneKey: 'tab-1:done', state: 'done' }),
        'tab-1:working': makeAgentEntry({ paneKey: 'tab-1:working' })
      },
      retainedAgentsByPaneKey: {
        'tab-1:retained': {
          entry: retainedEntry,
          tab: makeTab({ id: 'tab-1', worktreeId: 'wt-1' }),
          worktreeId: 'wt-1',
          agentType: 'codex',
          startedAt: retainedEntry.stateStartedAt
        }
      }
    } as Partial<AppState>)

    store.getState().captureSleepingAgentSessionsByWorktree('wt-1')

    const records = store.getState().sleepingAgentSessionsByPaneKey
    expect(records['tab-1:done'].restoreOnTabOpenOnly).toBe(true)
    expect(records['tab-1:retained'].restoreOnTabOpenOnly).toBe(true)
    // Why: a still-working pane is resumed by wake, not by opening its tab.
    expect(records['tab-1:working'].restoreOnTabOpenOnly).toBeUndefined()
  })

  it('carries a blocked legacy-orchestration-worker flag onto the replacement record', () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    const store = createTestStore()
    seedTabs(store)
    store.setState({
      agentStatusByPaneKey: {
        'tab-1:leaf-1': makeAgentEntry(),
        'tab-1:leaf-2': makeAgentEntry({ paneKey: 'tab-1:leaf-2' })
      },
      sleepingAgentSessionsByPaneKey: {
        'tab-1:leaf-1': makeSleepingRecord({
          providerSession: { key: 'session_id', id: 'session-tab-1:leaf-1' },
          automaticResumeBlockedBy: 'legacy-orchestration-worker'
        }),
        'tab-1:leaf-2': makeSleepingRecord({
          paneKey: 'tab-1:leaf-2',
          automaticResumeBlockedBy: 'legacy-orchestration-worker'
        })
      }
    } as Partial<AppState>)

    store.getState().captureSleepingAgentSessionsByWorktree('wt-1')

    const records = store.getState().sleepingAgentSessionsByPaneKey
    expect(records['tab-1:leaf-1'].automaticResumeBlockedBy).toBe('legacy-orchestration-worker')
    // Different provider session: the block belonged to a session that is no longer running here.
    expect(records['tab-1:leaf-2'].automaticResumeBlockedBy).toBeUndefined()
  })

  it('preserves retained completed sessions as intentional sleep records', () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    const store = createTestStore()
    seedTabs(store)
    const entry = makeAgentEntry({ paneKey: 'tab-1:done', state: 'done' })
    const tab = makeTab({ id: 'tab-1', worktreeId: 'wt-1' })
    store.setState({
      retainedAgentsByPaneKey: {
        'tab-1:done': {
          entry,
          tab,
          worktreeId: 'wt-1',
          agentType: 'codex',
          startedAt: entry.stateStartedAt
        }
      }
    } as Partial<AppState>)

    store.getState().captureSleepingAgentSessionsByWorktree('wt-1')

    expect(store.getState().sleepingAgentSessionsByPaneKey['tab-1:done']).toMatchObject({
      origin: 'worktree-sleep',
      state: 'done',
      providerSession: { key: 'session_id', id: 'session-tab-1:done' }
    })
  })

  // Why: a retained row is the pane's last status after its pty died, so it is stale by
  // construction — capturing it verbatim rebuilt a record wake discards as stale (#11598).
  it('refreshes a stale retained working row so wake cannot discard it', () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    const store = createTestStore()
    seedTabs(store)
    const entry = makeAgentEntry({
      paneKey: 'tab-1:retained',
      updatedAt: NOW - AGENT_STATUS_STALE_AFTER_MS - 1,
      interrupted: true
    })
    store.setState({
      retainedAgentsByPaneKey: {
        'tab-1:retained': {
          entry,
          tab: makeTab({ id: 'tab-1', worktreeId: 'wt-1' }),
          worktreeId: 'wt-1',
          agentType: 'codex',
          startedAt: entry.stateStartedAt
        }
      }
    } as Partial<AppState>)

    store.getState().captureSleepingAgentSessionsByWorktree('wt-1')

    const record = store.getState().sleepingAgentSessionsByPaneKey['tab-1:retained']
    expect(record).toMatchObject({ origin: 'worktree-sleep', state: 'working', updatedAt: NOW })
    expect(record.capturedAt - record.updatedAt).toBeLessThanOrEqual(AGENT_STATUS_STALE_AFTER_MS)
    expect(record.interrupted).toBeUndefined()
  })

  it('carries a blocked legacy-orchestration-worker flag onto a retained replacement record', () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    const store = createTestStore()
    seedTabs(store)
    const entry = makeAgentEntry({ paneKey: 'tab-1:retained', state: 'done' })
    store.setState({
      retainedAgentsByPaneKey: {
        'tab-1:retained': {
          entry,
          tab: makeTab({ id: 'tab-1', worktreeId: 'wt-1' }),
          worktreeId: 'wt-1',
          agentType: 'codex',
          startedAt: entry.stateStartedAt
        }
      },
      sleepingAgentSessionsByPaneKey: {
        'tab-1:retained': makeSleepingRecord({
          paneKey: 'tab-1:retained',
          providerSession: { key: 'session_id', id: 'session-tab-1:retained' },
          automaticResumeBlockedBy: 'legacy-orchestration-worker'
        })
      }
    } as Partial<AppState>)

    store.getState().captureSleepingAgentSessionsByWorktree('wt-1')

    expect(
      store.getState().sleepingAgentSessionsByPaneKey['tab-1:retained'].automaticResumeBlockedBy
    ).toBe('legacy-orchestration-worker')
  })

  // Why: the promoted checkpoint owns the pane's recovery identity (connection, transcript); the
  // retained pass must not re-derive over it any more than the live pass may.
  it('keeps a promoted live checkpoint that also has a retained row', () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    const store = createTestStore()
    seedTabs(store)
    const providerSession = { key: 'session_id', id: 'codex-shared' } as const
    const entry = makeAgentEntry({ paneKey: 'tab-1:leaf-1', state: 'done', providerSession })
    store.setState({
      sleepingAgentSessionsByPaneKey: {
        'tab-1:leaf-1': makeSleepingRecord({ providerSession, connectionId: 'conn-1' })
      },
      retainedAgentsByPaneKey: {
        'tab-1:leaf-1': {
          entry,
          tab: makeTab({ id: 'tab-1', worktreeId: 'wt-1' }),
          worktreeId: 'wt-1',
          agentType: 'codex',
          startedAt: entry.stateStartedAt
        }
      }
    } as Partial<AppState>)

    store.getState().captureSleepingAgentSessionsByWorktree('wt-1')

    const record = store.getState().sleepingAgentSessionsByPaneKey['tab-1:leaf-1']
    expect(record).toMatchObject({
      origin: 'worktree-sleep',
      state: 'working',
      connectionId: 'conn-1'
    })
    expect(record.restoreOnTabOpenOnly).toBeUndefined()
  })

  it('replaces pre-existing records for stale rows instead of dropping them', () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    const store = createTestStore()
    seedTabs(store)
    store.setState({
      agentStatusByPaneKey: {
        'tab-1:stale': makeAgentEntry({
          paneKey: 'tab-1:stale',
          updatedAt: NOW - AGENT_STATUS_STALE_AFTER_MS - 1
        })
      },
      sleepingAgentSessionsByPaneKey: {
        'tab-1:stale': makeSleepingRecord({ paneKey: 'tab-1:stale' })
      }
    } as Partial<AppState>)

    store.getState().captureSleepingAgentSessionsByWorktree('wt-1')

    expect(store.getState().sleepingAgentSessionsByPaneKey['tab-1:stale']).toMatchObject({
      origin: 'worktree-sleep',
      updatedAt: NOW,
      providerSession: { key: 'session_id', id: 'session-tab-1:stale' }
    })
  })

  it('keeps the live checkpoint of an interrupted pane as a worktree-sleep record', () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    const store = createTestStore()
    seedTabs(store)
    store
      .getState()
      .setAgentStatus(
        'tab-1:leaf-1',
        { state: 'done', prompt: 'do the thing', agentType: 'claude', interrupted: true },
        'Claude',
        { updatedAt: NOW, stateStartedAt: NOW },
        { tabId: 'tab-1', worktreeId: 'wt-1' },
        { providerSession: { key: 'session_id', id: 'claude-session-1' } }
      )
    expect(store.getState().sleepingAgentSessionsByPaneKey['tab-1:leaf-1']).toMatchObject({
      origin: 'live'
    })

    store.getState().captureSleepingAgentSessionsByWorktree('wt-1')

    expect(store.getState().sleepingAgentSessionsByPaneKey['tab-1:leaf-1']).toMatchObject({
      origin: 'worktree-sleep',
      state: 'done',
      agent: 'claude',
      providerSession: { key: 'session_id', id: 'claude-session-1' }
    })
  })

  // Why: a slept `done` pane stays passive until its tab is opened, so a second sleep finds no
  // live row to re-derive its record from — the wipe must leave it alone (#11598).
  it('keeps a durable slept record whose pane was never woken across a second sleep', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    const store = createTestStore()
    store.setState({
      tabsByWorktree: {
        'wt-1': [
          makeTab({ id: 'tab-1', worktreeId: 'wt-1' }),
          makeTab({ id: 'tab-2', worktreeId: 'wt-1' })
        ]
      },
      agentStatusByPaneKey: {
        'tab-1:leaf-1': makeAgentEntry({ paneKey: 'tab-1:leaf-1', state: 'done' })
      },
      sleepingAgentSessionsByPaneKey: {
        'tab-2:leaf-1': makeSleepingRecord({
          paneKey: 'tab-2:leaf-1',
          agent: 'claude',
          state: 'done',
          providerSession: { key: 'session_id', id: 'claude-never-woken' },
          origin: 'worktree-sleep'
        })
      }
    } as Partial<AppState>)

    await store.getState().shutdownWorktreeTerminals('wt-1', { keepIdentifiers: true })

    const records = store.getState().sleepingAgentSessionsByPaneKey
    expect(records['tab-2:leaf-1']).toMatchObject({
      origin: 'worktree-sleep',
      state: 'done',
      providerSession: { key: 'session_id', id: 'claude-never-woken' }
    })
    expect(records['tab-1:leaf-1']).toMatchObject({ origin: 'worktree-sleep', state: 'done' })
  })

  // Why: an unresumable `live` checkpoint is provisional, so the wipe must still clear it.
  it('does not promote Pi identity without an authoritative transcript', () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    const store = createTestStore()
    seedTabs(store)
    store.setState({
      sleepingAgentSessionsByPaneKey: {
        'tab-1:leaf-1': makeSleepingRecord({
          agent: 'pi',
          providerSession: { key: 'session_id', id: 'pi-session-1' }
        })
      }
    } as Partial<AppState>)

    store.getState().captureSleepingAgentSessionsByWorktree('wt-1')

    expect(store.getState().sleepingAgentSessionsByPaneKey['tab-1:leaf-1']).toBeUndefined()
  })

  it('captures resumable rows when terminal shutdown captures sleeping records', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    const store = createTestStore()
    seedTabs(store)
    store.setState({
      agentStatusByPaneKey: {
        'tab-1:fresh': makeAgentEntry({ paneKey: 'tab-1:fresh' }),
        'tab-1:done': makeAgentEntry({ paneKey: 'tab-1:done', state: 'done' })
      }
    } as Partial<AppState>)

    await store.getState().shutdownWorktreeTerminals('wt-1', { keepIdentifiers: true })

    const records = store.getState().sleepingAgentSessionsByPaneKey
    expect(Object.keys(records).sort()).toEqual(['tab-1:done', 'tab-1:fresh'])
    expect(records['tab-1:fresh']).toMatchObject({
      origin: 'worktree-sleep',
      state: 'working'
    })
    expect(records['tab-1:done']).toMatchObject({
      origin: 'worktree-sleep',
      state: 'done'
    })
  })

  // Why: runSleepWorktrees deactivates the workspace before terminal shutdown, so capture must
  // still see the live rows it is about to kill.
  it('captures done and interrupted rows after the slept worktree is deactivated', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    const store = createTestStore()
    seedTabs(store)
    store.setState({
      activeWorktreeId: 'wt-1',
      agentStatusByPaneKey: {
        'tab-1:done': makeAgentEntry({ paneKey: 'tab-1:done', state: 'done' }),
        'tab-1:interrupted': makeAgentEntry({
          paneKey: 'tab-1:interrupted',
          state: 'done',
          interrupted: true
        })
      }
    } as Partial<AppState>)

    store.getState().setActiveWorktree(null)
    await store.getState().shutdownWorktreeTerminals('wt-1', { keepIdentifiers: true })

    const records = store.getState().sleepingAgentSessionsByPaneKey
    expect(Object.keys(records).sort()).toEqual(['tab-1:done', 'tab-1:interrupted'])
    expect(records['tab-1:interrupted']).toMatchObject({
      origin: 'worktree-sleep',
      state: 'done'
    })
  })

  it('replaces pre-existing records for stale rows during terminal shutdown capture', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    const store = createTestStore()
    seedTabs(store)
    store.setState({
      ptyIdsByTabId: { 'tab-1': [] },
      agentStatusByPaneKey: {
        'tab-1:stale': makeAgentEntry({
          paneKey: 'tab-1:stale',
          updatedAt: NOW - AGENT_STATUS_STALE_AFTER_MS - 1
        })
      },
      sleepingAgentSessionsByPaneKey: {
        'tab-1:stale': makeSleepingRecord({ paneKey: 'tab-1:stale' })
      }
    } as Partial<AppState>)

    await store.getState().shutdownWorktreeTerminals('wt-1', { keepIdentifiers: true })

    expect(store.getState().sleepingAgentSessionsByPaneKey['tab-1:stale']).toMatchObject({
      origin: 'worktree-sleep',
      updatedAt: NOW,
      providerSession: { key: 'session_id', id: 'session-tab-1:stale' }
    })
  })
})
