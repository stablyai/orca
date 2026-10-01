import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../../../shared/agent-status-types'
import { createTestStore } from './store-test-helpers'

const NOW = 10 * AGENT_STATUS_STALE_AFTER_MS
const STALE_UPDATED_AT = NOW - AGENT_STATUS_STALE_AFTER_MS - 60_000
const FRESH_UPDATED_AT = NOW - 60_000

function makeAgentEntry(overrides: Partial<AgentStatusEntry> = {}): AgentStatusEntry {
  return {
    state: 'working',
    prompt: 'finish the task',
    updatedAt: FRESH_UPDATED_AT,
    stateStartedAt: FRESH_UPDATED_AT,
    stateHistory: [],
    agentType: 'claude',
    paneKey: 'tab-gone:leaf-1',
    worktreeId: 'wt-1',
    providerSession: { key: 'session_id', id: 'sess-1' },
    ...overrides
  }
}

function seedEntry(store: ReturnType<typeof createTestStore>, entry: AgentStatusEntry): void {
  store.setState({ agentStatusByPaneKey: { [entry.paneKey]: entry } })
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('captureAllSleepingAgentSessions periodic capture of stale entries', () => {
  it('does not re-mint a record the activation sweep cleared as stale', () => {
    // Regression (#23391): a stale entry for a vanished tab kept re-minting the record the
    // activation sweep had just cleared, so the tab-less duplicate came back on every tick.
    const store = createTestStore()
    seedEntry(store, makeAgentEntry({ updatedAt: STALE_UPDATED_AT }))

    store.getState().captureAllSleepingAgentSessions('periodic')

    expect(store.getState().sleepingAgentSessionsByPaneKey['tab-gone:leaf-1']).toBeUndefined()
  })

  it('still captures a fresh non-done entry', () => {
    const store = createTestStore()
    seedEntry(store, makeAgentEntry())

    store.getState().captureAllSleepingAgentSessions('periodic')

    expect(store.getState().sleepingAgentSessionsByPaneKey['tab-gone:leaf-1']).toMatchObject({
      providerSession: { key: 'session_id', id: 'sess-1' },
      state: 'working',
      origin: 'live',
      capturedAt: NOW
    })
  })

  it('keeps an existing record when its entry goes stale', () => {
    const store = createTestStore()
    seedEntry(store, makeAgentEntry())
    store.getState().captureAllSleepingAgentSessions('periodic')
    const captured = store.getState().sleepingAgentSessionsByPaneKey['tab-gone:leaf-1']

    vi.setSystemTime(NOW + AGENT_STATUS_STALE_AFTER_MS + 60_000)
    store.getState().captureAllSleepingAgentSessions('periodic')

    expect(store.getState().sleepingAgentSessionsByPaneKey['tab-gone:leaf-1']).toBe(captured)
  })

  it('leaves quit capture of a stale entry unchanged', () => {
    const store = createTestStore()
    seedEntry(store, makeAgentEntry({ updatedAt: STALE_UPDATED_AT }))

    store.getState().captureAllSleepingAgentSessions('quit')

    expect(store.getState().sleepingAgentSessionsByPaneKey['tab-gone:leaf-1']).toMatchObject({
      state: 'working',
      origin: 'quit'
    })
  })
})
