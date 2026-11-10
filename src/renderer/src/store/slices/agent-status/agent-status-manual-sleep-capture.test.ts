import { createStoreCascadesMockApi } from '../../testing/app-store-cascade-api.test-fixture'
import { applySleepRuntimeRpcDefault } from '../../terminals/terminal-sleep-rpc.test-fixture'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SleepingAgentSessionRecord } from '../../../../../shared/agent-session/lifecycle/agent-session-resume'
import type { AgentStatusEntry } from '../../../../../shared/agent-status/contracts/agent-status-types'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../../../../shared/agent-status/contracts/agent-status-freshness'
import type { AppState } from '../../types'
import { createTestStore } from '../../testing/app-store-test-fixture'
import { makeTab } from '../../terminals/terminal-tab.test-fixture'

const LEAF = '11111111-1111-4111-8111-111111111111'
const OTHER = '22222222-2222-4222-8222-222222222222'
const API = createStoreCascadesMockApi()
beforeEach(() => {
  vi.clearAllMocks()
  applySleepRuntimeRpcDefault(API)
  vi.stubGlobal('window', { api: API })
})

const NOW = 1_800_000_000_000

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

function makeAgentEntry(overrides: Partial<AgentStatusEntry> = {}): AgentStatusEntry {
  const paneKey = overrides.paneKey ?? 'tab-1:11111111-1111-4111-8111-111111111111'
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
    },
    ptyIdsByTabId: { 'tab-1': ['pty-1', 'pty-2'] },
    terminalLayoutsByTabId: {
      'tab-1': {
        root: {
          type: 'split',
          direction: 'horizontal',
          ratio: 0.5,
          first: { type: 'leaf', leafId: LEAF },
          second: { type: 'leaf', leafId: OTHER }
        },
        activeLeafId: LEAF,
        expandedLeafId: null,
        ptyIdsByLeafId: { [LEAF]: 'pty-1', [OTHER]: 'pty-2' }
      }
    }
  } as Partial<AppState>)
}

function makeSleepingRecord(
  overrides: Partial<SleepingAgentSessionRecord> = {}
): SleepingAgentSessionRecord {
  const paneKey = overrides.paneKey ?? 'tab-1:11111111-1111-4111-8111-111111111111'
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
        'tab-1:11111111-1111-4111-8111-111111111111': makeAgentEntry({
          paneKey: 'tab-1:11111111-1111-4111-8111-111111111111',
          state: 'done'
        })
      },
      sleepingAgentSessionsByPaneKey: {
        'tab-2:11111111-1111-4111-8111-111111111111': makeSleepingRecord({
          paneKey: 'tab-2:11111111-1111-4111-8111-111111111111',
          agent: 'claude',
          state: 'done',
          providerSession: { key: 'session_id', id: 'claude-never-woken' },
          origin: 'worktree-sleep'
        })
      }
    } as Partial<AppState>)

    const currentTabs = store.getState().tabsByWorktree
    seedTabs(store)
    store.setState({ tabsByWorktree: currentTabs })
    await store.getState().shutdownWorktreeTerminals('wt-1', { keepIdentifiers: true })

    const records = store.getState().sleepingAgentSessionsByPaneKey
    expect(records['tab-2:11111111-1111-4111-8111-111111111111']).toMatchObject({
      origin: 'worktree-sleep',
      state: 'done',
      providerSession: { key: 'session_id', id: 'claude-never-woken' }
    })
    expect(records['tab-1:11111111-1111-4111-8111-111111111111']).toMatchObject({
      origin: 'worktree-sleep',
      state: 'done'
    })
  })

  // Why: an unresumable `live` checkpoint is provisional, so the wipe must still clear it.
  it('does not promote Pi identity without an authoritative transcript', () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    const store = createTestStore()
    seedTabs(store)
    store.setState({
      sleepingAgentSessionsByPaneKey: {
        'tab-1:11111111-1111-4111-8111-111111111111': makeSleepingRecord({
          agent: 'pi',
          providerSession: { key: 'session_id', id: 'pi-session-1' }
        })
      }
    } as Partial<AppState>)

    store.getState().captureSleepingAgentSessionsByWorktree('wt-1')

    expect(
      store.getState().sleepingAgentSessionsByPaneKey['tab-1:11111111-1111-4111-8111-111111111111']
    ).toBeUndefined()
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
        'tab-1:11111111-1111-4111-8111-111111111111': makeAgentEntry({
          paneKey: 'tab-1:11111111-1111-4111-8111-111111111111',
          state: 'done'
        }),
        'tab-1:22222222-2222-4222-8222-222222222222': makeAgentEntry({
          paneKey: 'tab-1:22222222-2222-4222-8222-222222222222',
          state: 'done',
          interrupted: true
        })
      }
    } as Partial<AppState>)

    store.getState().setActiveWorktree(null)
    await store.getState().shutdownWorktreeTerminals('wt-1', { keepIdentifiers: true })

    const records = store.getState().sleepingAgentSessionsByPaneKey
    expect(Object.keys(records).sort()).toEqual([
      'tab-1:11111111-1111-4111-8111-111111111111',
      'tab-1:22222222-2222-4222-8222-222222222222'
    ])
    expect(records['tab-1:22222222-2222-4222-8222-222222222222']).toMatchObject({
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
      agentStatusByPaneKey: {
        'tab-1:11111111-1111-4111-8111-111111111111': makeAgentEntry({
          paneKey: 'tab-1:11111111-1111-4111-8111-111111111111',
          updatedAt: NOW - AGENT_STATUS_STALE_AFTER_MS - 1
        })
      },
      sleepingAgentSessionsByPaneKey: {
        'tab-1:11111111-1111-4111-8111-111111111111': makeSleepingRecord({
          paneKey: 'tab-1:11111111-1111-4111-8111-111111111111'
        })
      }
    } as Partial<AppState>)

    await store.getState().shutdownWorktreeTerminals('wt-1', { keepIdentifiers: true })

    expect(
      store.getState().sleepingAgentSessionsByPaneKey['tab-1:11111111-1111-4111-8111-111111111111']
    ).toMatchObject({
      origin: 'worktree-sleep',
      updatedAt: NOW - AGENT_STATUS_STALE_AFTER_MS - 1,
      providerSession: {
        key: 'session_id',
        id: 'session-tab-1:11111111-1111-4111-8111-111111111111'
      }
    })
  })
})

it.each([NOW - 1, NOW + 1])(
  'identity-only evidence at %i keeps a resumable sleep until accepted successor activity',
  (at) => {
    const store = createTestStore()
    seedTabs(store)
    const record = makeSleepingRecord({
      origin: 'worktree-sleep',
      state: 'done',
      capturedAt: NOW,
      updatedAt: NOW - 1000
    })
    store.setState({
      sleepingAgentSessionsByPaneKey: { [record.paneKey]: record },
      agentStatusByPaneKey: {}
    })
    store
      .getState()
      .recordAgentProviderSession(
        record.paneKey,
        'codex',
        record.providerSession,
        { updatedAt: at },
        { tabId: 'tab-1', worktreeId: 'wt-1' }
      )
    expect(store.getState().sleepingAgentSessionsByPaneKey[record.paneKey]).toBe(record)
    store
      .getState()
      .setAgentStatus(
        record.paneKey,
        { state: 'working', agentType: 'codex', prompt: 'new task' },
        undefined,
        { updatedAt: NOW + 2, stateStartedAt: NOW + 2 },
        { tabId: 'tab-1', worktreeId: 'wt-1' },
        { providerSession: record.providerSession }
      )
    expect(store.getState().sleepingAgentSessionsByPaneKey[record.paneKey]?.origin).toBe('live')
    store.getState().removeAgentStatus(record.paneKey)
    expect(store.getState().sleepingAgentSessionsByPaneKey[record.paneKey]?.origin).toBe('live')
  }
)
