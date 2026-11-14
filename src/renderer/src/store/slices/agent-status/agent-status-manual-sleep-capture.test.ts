import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SleepingAgentSessionRecord } from '../../../../../shared/agent-session/lifecycle/agent-session-resume'
import type { AgentStatusEntry } from '../../../../../shared/agent-status/contracts/agent-status-types'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../../../../shared/agent-status/contracts/agent-status-freshness'
import type { AppState } from '../../types'
import { createTestStore } from '../../testing/app-store-test-fixture'
import { makeTab } from '../../terminals/testing/terminal-tab.test-fixture'

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
  // Promoted checkpoint owns connection/transcript identity; retained pass must not overwrite it.
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

  // Slept done panes stay passive until opened; repeated sleep has no live row and must preserve recovery (#11598).
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

  // Sleep deactivates workspace before killing terminals; capture must still find its live rows.
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
