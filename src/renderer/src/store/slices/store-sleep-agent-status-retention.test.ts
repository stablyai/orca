import { describe, it, expect, vi, beforeEach } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import { clearRuntimeCompatibilityCacheForTests } from '../../runtime/runtime-rpc-client'
import { createTestStore, makeTab, makeWorktree, seedStore } from './store-test-helpers'
import { shutdownBufferCaptures } from '@/components/terminal-pane/shutdown-buffer-captures'
import {
  applySleepRuntimeRpcDefault,
  createStoreCascadesMockApi
} from './store-cascades-test-harness'

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

// Sleep must clear live/retained status or mid-turn agents remain working until the 30-minute TTL.
describe('shutdownWorktreeTerminals (sleep) — agent status hygiene', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    clearRuntimeCompatibilityCacheForTests()
    mockApi.pty.kill.mockResolvedValue(undefined)
    mockUnregisterPtyDataHandlers.mockReturnValue([])
    applySleepRuntimeRpcDefault(mockApi)
    shutdownBufferCaptures.clear()
  })

  it('captures allowlisted done live sleeping pane sessions during manual sleep', async () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'

    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      },
      tabsByWorktree: {
        [wt]: [makeTab({ id: 'tab-1', worktreeId: wt, title: 'Codex' })]
      },
      ptyIdsByTabId: { 'tab-1': ['pty-1'] }
    })

    store.getState().setAgentStatus(
      'tab-1:live',
      {
        state: 'done',
        prompt: 'resume live',
        agentType: 'codex'
      },
      'Codex',
      { updatedAt: 1000, stateStartedAt: 1000 },
      { tabId: 'tab-1', worktreeId: wt },
      { providerSession: { key: 'session_id', id: 'live-session' } }
    )
    store.getState().retainAgents([
      {
        entry: {
          paneKey: 'tab-1:retained',
          state: 'done',
          stateStartedAt: 900,
          updatedAt: 900,
          prompt: 'old retained',
          agentType: 'codex',
          providerSession: { key: 'session_id', id: 'old-session' },
          stateHistory: []
        },
        tab: makeTab({ id: 'tab-1', worktreeId: wt, title: 'Old Codex' }),
        worktreeId: wt,
        agentType: 'codex',
        startedAt: 900
      }
    ])

    await store.getState().shutdownWorktreeTerminals(wt, {
      keepIdentifiers: true,
      sleepingPaneKeys: ['tab-1:live']
    })

    const state = store.getState()
    expect(state.sleepingAgentSessionsByPaneKey['tab-1:live']).toMatchObject({
      origin: 'worktree-sleep',
      state: 'done',
      providerSession: { key: 'session_id', id: 'live-session' }
    })
    expect(state.sleepingAgentSessionsByPaneKey['tab-1:retained']).toBeUndefined()
  })

  it('retains only clean slept completions during automatic hibernation', async () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'
    const otherWt = 'repo1::/path/wt2'

    seedStore(store, {
      worktreesByRepo: {
        repo1: [
          makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' }),
          makeWorktree({ id: otherWt, repoId: 'repo1', path: '/path/wt2' })
        ]
      },
      tabsByWorktree: {
        [wt]: [makeTab({ id: 'tab-1', worktreeId: wt, title: 'Codex' })],
        [otherWt]: [makeTab({ id: 'tab-2', worktreeId: otherWt, title: 'Codex' })]
      },
      ptyIdsByTabId: { 'tab-1': ['pty-1'], 'tab-2': ['pty-2'] }
    })

    store.getState().setAgentStatus(
      'tab-1:live',
      {
        state: 'working',
        prompt: 'new retained prompt',
        agentType: 'codex'
      },
      'Codex',
      { updatedAt: 1800, stateStartedAt: 1800 },
      { tabId: 'tab-1', worktreeId: wt },
      { providerSession: { key: 'session_id', id: 'live-session' } }
    )
    store.getState().setAgentStatus(
      'tab-1:live',
      {
        state: 'done',
        prompt: 'new retained prompt',
        agentType: 'codex',
        lastAssistantMessage: 'new final message',
        interrupted: false
      },
      'Codex',
      { updatedAt: 2000, stateStartedAt: 2000 },
      { tabId: 'tab-1', worktreeId: wt },
      { providerSession: { key: 'session_id', id: 'live-session' } }
    )
    store.getState().retainAgents([
      {
        entry: {
          paneKey: 'tab-1:live',
          state: 'done',
          stateStartedAt: 1000,
          updatedAt: 1000,
          stateHistory: [],
          prompt: 'stale same-pane prompt',
          agentType: 'codex',
          providerSession: { key: 'session_id', id: 'old-session' }
        },
        worktreeId: wt,
        tab: makeTab({ id: 'tab-1', worktreeId: wt, title: 'Old Codex' }),
        agentType: 'codex',
        startedAt: 1000
      },
      {
        entry: {
          paneKey: 'tab-1:retained',
          state: 'done',
          stateStartedAt: 1500,
          updatedAt: 1500,
          stateHistory: [],
          prompt: 'unslept retained prompt',
          agentType: 'codex'
        },
        worktreeId: wt,
        tab: makeTab({ id: 'tab-1', worktreeId: wt, title: 'Codex' }),
        agentType: 'codex',
        startedAt: 1500
      },
      {
        entry: {
          paneKey: 'tab-2:retained',
          state: 'done',
          stateStartedAt: 1600,
          updatedAt: 1600,
          stateHistory: [],
          prompt: 'other retained prompt',
          agentType: 'codex'
        },
        worktreeId: otherWt,
        tab: makeTab({ id: 'tab-2', worktreeId: otherWt, title: 'Codex' }),
        agentType: 'codex',
        startedAt: 1600
      }
    ])
    store.getState().acknowledgeAgents(['tab-1:live', 'tab-1:retained', 'tab-2:retained'])
    const liveAck = store.getState().acknowledgedAgentsByPaneKey['tab-1:live']
    store.getState().setMigrationUnsupportedPty({
      ptyId: 'pty-legacy',
      worktreeId: wt,
      paneKey: 'tab-1:legacy',
      reason: 'legacy-numeric-pane-key',
      source: 'local',
      updatedAt: 1700
    })

    await store.getState().shutdownWorktreeTerminals(wt, {
      keepIdentifiers: true,
      shutdownReason: 'auto-hibernate-completed-agent',
      sleepingPaneKeys: ['tab-1:live']
    })

    const state = store.getState()
    expect(state.agentStatusByPaneKey['tab-1:live']).toBeUndefined()
    expect(state.retainedAgentsByPaneKey['tab-1:live']).toMatchObject({
      worktreeId: wt,
      startedAt: 1800,
      entry: {
        prompt: 'new retained prompt',
        lastAssistantMessage: 'new final message',
        providerSession: { key: 'session_id', id: 'live-session' }
      }
    })
    expect(state.sleepingAgentSessionsByPaneKey['tab-1:live']).toMatchObject({
      paneKey: 'tab-1:live',
      origin: 'worktree-sleep',
      providerSession: { key: 'session_id', id: 'live-session' }
    })
    expect(state.retainedAgentsByPaneKey['tab-1:retained']).toBeUndefined()
    expect(state.retainedAgentsByPaneKey['tab-2:retained']).toBeDefined()
    expect(state.acknowledgedAgentsByPaneKey['tab-1:live']).toBe(liveAck)
    expect(state.acknowledgedAgentsByPaneKey['tab-1:retained']).toBeUndefined()
    expect(state.acknowledgedAgentsByPaneKey['tab-2:retained']).toBeGreaterThan(0)
    expect(state.migrationUnsupportedByPtyId['pty-legacy']).toBeUndefined()
    expect(state.retentionSuppressedPaneKeys['tab-1:live']).toBeUndefined()
  })

  it('does not preserve provider session metadata when a pane switches agent type', async () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'

    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      },
      tabsByWorktree: {
        [wt]: [makeTab({ id: 'tab-1', worktreeId: wt, title: 'Claude' })]
      },
      ptyIdsByTabId: { 'tab-1': ['pty-1'] }
    })

    store.getState().setAgentStatus(
      'tab-1:0',
      {
        state: 'done',
        prompt: 'codex prompt',
        agentType: 'codex',
        interrupted: false
      },
      'Codex',
      { updatedAt: 1000, stateStartedAt: 1000 },
      { tabId: 'tab-1', worktreeId: wt },
      { providerSession: { key: 'session_id', id: 'codex-session-1' } }
    )

    store.getState().setAgentStatus(
      'tab-1:0',
      {
        state: 'working',
        prompt: 'claude prompt',
        agentType: 'claude'
      },
      'Claude',
      { updatedAt: 2000, stateStartedAt: 2000 },
      { tabId: 'tab-1', worktreeId: wt }
    )

    const liveEntry = store.getState().agentStatusByPaneKey['tab-1:0']
    expect(liveEntry?.agentType).toBe('claude')
    expect(liveEntry?.providerSession).toBeUndefined()

    await store.getState().shutdownWorktreeTerminals(wt, { keepIdentifiers: true })

    const state = store.getState()
    expect(state.agentStatusByPaneKey['tab-1:0']).toBeUndefined()
    expect(state.sleepingAgentSessionsByPaneKey['tab-1:0']).toBeUndefined()
  })
})
