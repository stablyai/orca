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
  it('captures only fresh active live rows as worktree-sleep records', () => {
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
    expect(Object.keys(records).sort()).toEqual(['tab-1:fresh'])
    expect(records['tab-1:fresh']).toMatchObject({
      origin: 'worktree-sleep',
      state: 'working',
      providerSession: { key: 'session_id', id: 'session-tab-1:fresh' }
    })
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

  it('clears pre-existing records for rows skipped by manual capture', () => {
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

    expect(store.getState().sleepingAgentSessionsByPaneKey['tab-1:stale']).toBeUndefined()
  })

  it('uses manual sleep filtering when terminal shutdown captures sleeping records', async () => {
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
    expect(Object.keys(records)).toEqual(['tab-1:fresh'])
    expect(records['tab-1:fresh']).toMatchObject({
      origin: 'worktree-sleep',
      state: 'working'
    })
  })

  it('clears pre-existing records for rows skipped during terminal shutdown capture', async () => {
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

    expect(store.getState().sleepingAgentSessionsByPaneKey['tab-1:stale']).toBeUndefined()
  })
})
