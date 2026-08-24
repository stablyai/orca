import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SleepingAgentSessionRecord } from '../../../../shared/agent-session-resume'
import {
  AGENT_STATUS_STALE_AFTER_MS,
  type AgentStatusEntry
} from '../../../../shared/agent-status-types'
import type * as AgentStatusModule from '@/lib/agent-status'
import { shutdownBufferCaptures } from '@/components/terminal-pane/shutdown-buffer-captures'
import { clearRuntimeCompatibilityCacheForTests } from '../../runtime/runtime-rpc-client'
import type { AppState } from '../types'
import {
  applySleepRuntimeRpcDefault,
  createStoreCascadesMockApi
} from './store-cascades-test-harness'
import { createTestStore, makeTab } from './store-test-helpers'

const NOW = 1_800_000_000_000
const STALE_AT = NOW - AGENT_STATUS_STALE_AFTER_MS - 1

const mockUnregisterPtyDataHandlers = vi.hoisted(() => vi.fn<() => unknown[]>(() => []))
const mockRestorePtyDataHandlersAfterFailedShutdown = vi.hoisted(() => vi.fn())

vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() }
}))

vi.mock('@/components/terminal-pane/pty-dispatcher', () => ({
  restorePtyDataHandlersAfterFailedShutdown: mockRestorePtyDataHandlersAfterFailedShutdown,
  unregisterPtyDataHandlers: mockUnregisterPtyDataHandlers
}))

vi.mock('@/lib/agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return {
    ...actual,
    detectAgentStatusFromTitle: vi.fn().mockReturnValue(null)
  }
})

const mockApi = createStoreCascadesMockApi()

afterEach(() => {
  vi.useRealTimers()
})

beforeEach(() => {
  vi.clearAllMocks()
  clearRuntimeCompatibilityCacheForTests()
  mockApi.pty.kill.mockResolvedValue(undefined)
  mockUnregisterPtyDataHandlers.mockReturnValue([])
  applySleepRuntimeRpcDefault(mockApi)
  shutdownBufferCaptures.clear()
})

function makeAgentEntry(overrides: Partial<AgentStatusEntry> = {}): AgentStatusEntry {
  const paneKey = overrides.paneKey ?? 'tab-1:leaf-1'
  return {
    state: 'working',
    prompt: 'finish the task',
    updatedAt: NOW,
    stateStartedAt: NOW,
    stateHistory: [],
    agentType: 'claude',
    paneKey,
    tabId: paneKey.split(':')[0],
    worktreeId: 'wt-1',
    providerSession: { key: 'session_id', id: `session-${paneKey}` },
    ...overrides
  }
}

function makeSleepingRecord(
  overrides: Partial<SleepingAgentSessionRecord> = {}
): SleepingAgentSessionRecord {
  const paneKey = overrides.paneKey ?? 'tab-1:leaf-1'
  return {
    paneKey,
    tabId: paneKey.split(':')[0],
    worktreeId: 'wt-1',
    agent: 'claude',
    providerSession: { key: 'session_id', id: `sleeping-${paneKey}` },
    prompt: 'old prompt',
    state: 'working',
    capturedAt: STALE_AT,
    updatedAt: STALE_AT,
    origin: 'live',
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

describe('manual sleep stale session recovery', () => {
  // Why: freshness is a display TTL. A quiet Claude whose provider session id still exists
  // in an origin:live checkpoint must be promoted even when the live row lost that id (STA-2844).
  it('promotes a stale origin:live Claude checkpoint when the live row has no session id', () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    const store = createTestStore()
    seedTabs(store)
    store.setState({
      agentStatusByPaneKey: {
        'tab-1:leaf-1': makeAgentEntry({
          updatedAt: STALE_AT,
          providerSession: undefined
        })
      },
      sleepingAgentSessionsByPaneKey: {
        'tab-1:leaf-1': makeSleepingRecord({
          providerSession: { key: 'session_id', id: 'claude-persisted' }
        })
      }
    } as Partial<AppState>)

    store.getState().captureSleepingAgentSessionsByWorktree('wt-1')

    const record = store.getState().sleepingAgentSessionsByPaneKey['tab-1:leaf-1']
    expect(record).toMatchObject({
      origin: 'worktree-sleep',
      providerSession: { key: 'session_id', id: 'claude-persisted' },
      updatedAt: STALE_AT
    })
  })

  it('captures a quiet-past-freshness live Claude row without pretending it is fresh', () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    const store = createTestStore()
    seedTabs(store)
    store.setState({
      agentStatusByPaneKey: {
        'tab-1:stale': makeAgentEntry({
          paneKey: 'tab-1:stale',
          updatedAt: STALE_AT,
          providerSession: { key: 'session_id', id: 'claude-quiet' }
        })
      }
    } as Partial<AppState>)

    store.getState().captureSleepingAgentSessionsByWorktree('wt-1')

    const record = store.getState().sleepingAgentSessionsByPaneKey['tab-1:stale']
    expect(record).toMatchObject({
      origin: 'worktree-sleep',
      providerSession: { key: 'session_id', id: 'claude-quiet' },
      updatedAt: STALE_AT
    })
    expect(record.capturedAt - record.updatedAt).toBeGreaterThan(AGENT_STATUS_STALE_AFTER_MS)
  })

  it('does not fabricate a resume record for a shell with no agent evidence', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    const store = createTestStore()
    seedTabs(store)
    store.setState({
      ptyIdsByTabId: { 'tab-1': ['pty-shell'] }
    } as Partial<AppState>)

    await store.getState().shutdownWorktreeTerminals('wt-1', { keepIdentifiers: true })

    expect(store.getState().sleepingAgentSessionsByPaneKey['tab-1:leaf-1']).toBeUndefined()
    expect(Object.keys(store.getState().sleepingAgentSessionsByPaneKey)).toEqual([])
    expect(mockApi.pty.kill).toHaveBeenCalledWith('pty-shell', { keepHistory: true })
  })

  it('rejects preflight when a renderer PTY has an unrecordable live Claude pane', () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    const store = createTestStore()
    seedTabs(store)
    store.setState({
      ptyIdsByTabId: { 'tab-1': ['pty-claude'] },
      agentStatusByPaneKey: {
        'tab-1:leaf-1': makeAgentEntry({ providerSession: undefined })
      }
    } as Partial<AppState>)

    expect(() => store.getState().preflightManualWorktreeSleep('wt-1')).toThrow(
      'agent_sleep_capture_missing'
    )

    expect(mockApi.pty.kill).not.toHaveBeenCalled()
    expect(store.getState().sleepingAgentSessionsByPaneKey).toEqual({})
  })

  it('allows preflight without renderer PTYs even when a stale row cannot be recorded', () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    const store = createTestStore()
    seedTabs(store)
    store.setState({
      ptyIdsByTabId: { 'tab-1': [] },
      agentStatusByPaneKey: {
        'tab-1:leaf-1': makeAgentEntry({
          updatedAt: STALE_AT,
          providerSession: undefined
        })
      }
    } as Partial<AppState>)

    expect(() => store.getState().preflightManualWorktreeSleep('wt-1')).not.toThrow()
    expect(store.getState().sleepingAgentSessionsByPaneKey).toEqual({})
  })

  // Why: killing a still-running resumable agent without a recovery record is the
  // destructive gap. Sleep must keep the PTY and surface the miss (STA-2844).
  it('aborts sleep instead of killing a live Claude pane it cannot record', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    const store = createTestStore()
    seedTabs(store)
    store.setState({
      ptyIdsByTabId: { 'tab-1': ['pty-claude'] },
      agentStatusByPaneKey: {
        'tab-1:leaf-1': makeAgentEntry({ providerSession: undefined })
      }
    } as Partial<AppState>)

    await expect(
      store.getState().shutdownWorktreeTerminals('wt-1', { keepIdentifiers: true })
    ).rejects.toThrow('agent_sleep_capture_missing')

    expect(mockApi.pty.kill).not.toHaveBeenCalled()
    expect(store.getState().sleepingAgentSessionsByPaneKey['tab-1:leaf-1']).toBeUndefined()
  })
})
