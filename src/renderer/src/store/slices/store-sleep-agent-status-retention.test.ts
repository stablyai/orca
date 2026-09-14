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

// Mock sonner (imported by repos.ts)
vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() }
}))

vi.mock('@/components/terminal-pane/pty-dispatcher', () => ({
  restorePtyDataHandlersAfterFailedShutdown: mockRestorePtyDataHandlersAfterFailedShutdown,
  unregisterPtyDataHandlers: mockUnregisterPtyDataHandlers
}))

// Mock agent-status (imported by terminal-helpers)
vi.mock('@/lib/agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return {
    ...actual,
    detectAgentStatusFromTitle: vi.fn().mockReturnValue(null)
  }
})

const mockApi = createStoreCascadesMockApi()

// Why: sleep must drop live + retained agent-status rows, else a mid-turn agent stays "working" until the 30-min stale TTL.
describe('shutdownWorktreeTerminals (sleep) — agent status hygiene', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    clearRuntimeCompatibilityCacheForTests()
    mockApi.pty.kill.mockResolvedValue(undefined)
    mockUnregisterPtyDataHandlers.mockReturnValue([])
    applySleepRuntimeRpcDefault(mockApi)
    shutdownBufferCaptures.clear()
  })

  it('drops live agentStatusByPaneKey entries on sleep so the working row disappears', async () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'

    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      },
      tabsByWorktree: {
        [wt]: [makeTab({ id: 'tab-1', worktreeId: wt })]
      },
      ptyIdsByTabId: { 'tab-1': ['pty-1'] }
    })

    store.getState().setAgentStatus('tab-1:0', {
      state: 'working',
      prompt: 'p',
      agentType: 'claude'
    })
    expect(store.getState().agentStatusByPaneKey['tab-1:0']).toBeDefined()

    await store.getState().shutdownWorktreeTerminals(wt, { keepIdentifiers: true })

    const s = store.getState()
    expect(s.agentStatusByPaneKey['tab-1:0']).toBeUndefined()
  })

  it('captures resumable provider session metadata before dropping sleep-time rows', async () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'
    const now = Date.now()

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
      'tab-1:0',
      {
        state: 'working',
        prompt: 'resume this',
        agentType: 'codex'
      },
      'Codex',
      { updatedAt: now, stateStartedAt: now },
      { tabId: 'tab-1', worktreeId: wt },
      { providerSession: { key: 'session_id', id: 'codex-session-1' } }
    )

    await store.getState().shutdownWorktreeTerminals(wt, { keepIdentifiers: true })

    const state = store.getState()
    expect(state.agentStatusByPaneKey['tab-1:0']).toBeUndefined()
    expect(state.sleepingAgentSessionsByPaneKey['tab-1:0']).toMatchObject({
      paneKey: 'tab-1:0',
      tabId: 'tab-1',
      worktreeId: wt,
      agent: 'codex',
      origin: 'worktree-sleep',
      providerSession: { key: 'session_id', id: 'codex-session-1' },
      prompt: 'resume this',
      terminalTitle: 'Codex'
    })
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
    // Outside the allowlist, so manual sleep never claimed it.
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

  it('does not retain interrupted, non-done, or retained-only rows on automatic hibernation', async () => {
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

    store.getState().setAgentStatus('tab-1:interrupted', {
      state: 'done',
      prompt: 'cancelled',
      agentType: 'codex',
      interrupted: true
    })
    store.getState().setAgentStatus('tab-1:working', {
      state: 'working',
      prompt: 'still working',
      agentType: 'codex'
    })
    store.getState().retainAgents([
      {
        entry: {
          paneKey: 'tab-1:retained-only',
          state: 'done',
          stateStartedAt: 1000,
          updatedAt: 1000,
          stateHistory: [],
          prompt: 'retained only',
          agentType: 'codex'
        },
        worktreeId: wt,
        tab: makeTab({ id: 'tab-1', worktreeId: wt, title: 'Codex' }),
        agentType: 'codex',
        startedAt: 1000
      }
    ])
    store
      .getState()
      .acknowledgeAgents(['tab-1:interrupted', 'tab-1:working', 'tab-1:retained-only'])

    await store.getState().shutdownWorktreeTerminals(wt, {
      keepIdentifiers: true,
      shutdownReason: 'auto-hibernate-completed-agent',
      sleepingPaneKeys: ['tab-1:interrupted', 'tab-1:working', 'tab-1:retained-only']
    })

    const state = store.getState()
    expect(state.sleepingAgentSessionsByPaneKey['tab-1:interrupted']).toBeUndefined()
    expect(state.sleepingAgentSessionsByPaneKey['tab-1:working']).toBeUndefined()
    expect(state.sleepingAgentSessionsByPaneKey['tab-1:retained-only']).toBeUndefined()
    expect(state.retainedAgentsByPaneKey['tab-1:interrupted']).toBeUndefined()
    expect(state.retainedAgentsByPaneKey['tab-1:working']).toBeUndefined()
    expect(state.retainedAgentsByPaneKey['tab-1:retained-only']).toBeUndefined()
    expect(state.acknowledgedAgentsByPaneKey['tab-1:interrupted']).toBeUndefined()
    expect(state.acknowledgedAgentsByPaneKey['tab-1:working']).toBeUndefined()
    expect(state.acknowledgedAgentsByPaneKey['tab-1:retained-only']).toBeUndefined()
    expect(state.retentionSuppressedPaneKeys['tab-1:interrupted']).toBe(true)
    expect(state.retentionSuppressedPaneKeys['tab-1:working']).toBe(true)
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

  it('drops retainedAgentsByPaneKey entries for the slept worktree', async () => {
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
        [wt]: [makeTab({ id: 'tab-1', worktreeId: wt })],
        [otherWt]: [makeTab({ id: 'tab-2', worktreeId: otherWt })]
      },
      ptyIdsByTabId: { 'tab-1': ['pty-1'] }
    })

    // Retained rows render by worktreeId, so sleep must sweep the orphan row too, not just tab prefixes.
    store.getState().retainAgents([
      {
        entry: {
          paneKey: 'tab-1:0',
          state: 'done',
          stateStartedAt: 1000,
          updatedAt: 1000,
          stateHistory: [],
          prompt: 'finished prompt',
          agentType: 'claude',
          terminalTitle: undefined,
          interrupted: false
        },
        worktreeId: wt,
        tab: makeTab({ id: 'tab-1', worktreeId: wt, title: 'Claude' }),
        agentType: 'claude',
        startedAt: 1000
      },
      {
        entry: {
          paneKey: 'tab-orphan:0',
          state: 'done',
          stateStartedAt: 1001,
          updatedAt: 1001,
          stateHistory: [],
          prompt: 'orphaned finished prompt',
          agentType: 'claude',
          terminalTitle: undefined,
          interrupted: false
        },
        worktreeId: wt,
        tab: makeTab({ id: 'tab-orphan', worktreeId: wt, title: 'Claude' }),
        agentType: 'claude',
        startedAt: 1001
      },
      {
        entry: {
          paneKey: 'tab-2:0',
          state: 'done',
          stateStartedAt: 1002,
          updatedAt: 1002,
          stateHistory: [],
          prompt: 'other prompt',
          agentType: 'claude',
          terminalTitle: undefined,
          interrupted: false
        },
        worktreeId: otherWt,
        tab: makeTab({ id: 'tab-2', worktreeId: otherWt, title: 'Claude' }),
        agentType: 'claude',
        startedAt: 1002
      }
    ])
    expect(store.getState().retainedAgentsByPaneKey['tab-1:0']).toBeDefined()
    expect(store.getState().retainedAgentsByPaneKey['tab-orphan:0']).toBeDefined()
    expect(store.getState().retainedAgentsByPaneKey['tab-2:0']).toBeDefined()
    store.getState().acknowledgeAgents(['tab-1:0', 'tab-orphan:0', 'tab-2:0'])

    await store.getState().shutdownWorktreeTerminals(wt, { keepIdentifiers: true })

    expect(store.getState().retainedAgentsByPaneKey['tab-1:0']).toBeUndefined()
    expect(store.getState().retainedAgentsByPaneKey['tab-orphan:0']).toBeUndefined()
    expect(store.getState().retainedAgentsByPaneKey['tab-2:0']).toBeDefined()
    expect(store.getState().acknowledgedAgentsByPaneKey['tab-1:0']).toBeUndefined()
    expect(store.getState().acknowledgedAgentsByPaneKey['tab-orphan:0']).toBeUndefined()
    expect(store.getState().acknowledgedAgentsByPaneKey['tab-2:0']).toBeGreaterThan(0)
  })

  it('clears prior acknowledgements on sleep because the worktree surface is folded', async () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'

    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      },
      tabsByWorktree: {
        [wt]: [makeTab({ id: 'tab-1', worktreeId: wt })]
      },
      ptyIdsByTabId: { 'tab-1': ['pty-1'] }
    })

    store.getState().setAgentStatus('tab-1:0', {
      state: 'working',
      prompt: 'p',
      agentType: 'claude'
    })
    store.getState().acknowledgeAgents(['tab-1:0'])
    const ackBeforeSleep = store.getState().acknowledgedAgentsByPaneKey['tab-1:0']
    expect(ackBeforeSleep).toBeGreaterThan(0)

    await store.getState().shutdownWorktreeTerminals(wt, { keepIdentifiers: true })

    expect(store.getState().acknowledgedAgentsByPaneKey['tab-1:0']).toBeUndefined()
  })

  it('plants retention suppressors on sleep so a previously-live `done` cannot re-retain', async () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'

    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      },
      tabsByWorktree: {
        [wt]: [makeTab({ id: 'tab-1', worktreeId: wt })]
      },
      ptyIdsByTabId: { 'tab-1': ['pty-1'] }
    })

    store.getState().setAgentStatus('tab-1:0', {
      state: 'done',
      prompt: 'p',
      agentType: 'claude'
    })
    expect(store.getState().retentionSuppressedPaneKeys['tab-1:0']).toBeUndefined()

    await store.getState().shutdownWorktreeTerminals(wt, { keepIdentifiers: true })

    // Why: sleep folds retained rows too, so the next retention sync must not recreate a slept `done` row.
    expect(store.getState().retentionSuppressedPaneKeys['tab-1:0']).toBe(true)
  })

  it('preserves existing retention suppressors across sleep (identity-preserved suppressor map)', async () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'

    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      },
      tabsByWorktree: {
        [wt]: [makeTab({ id: 'tab-1', worktreeId: wt })]
      },
      ptyIdsByTabId: { 'tab-1': ['pty-1'] },
      retentionSuppressedPaneKeys: { 'tab-1:0': true }
    })

    expect(store.getState().retentionSuppressedPaneKeys['tab-1:0']).toBe(true)

    await store.getState().shutdownWorktreeTerminals(wt, { keepIdentifiers: true })

    // Why: a suppressor planted by a prior dismissal must survive sleep, else the dismissed row resurfaces.
    expect(store.getState().retentionSuppressedPaneKeys['tab-1:0']).toBe(true)
  })

  it('still wipes retained + ack entries under remove-worktree shutdown', async () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'

    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      },
      tabsByWorktree: {
        [wt]: [makeTab({ id: 'tab-1', worktreeId: wt })]
      },
      ptyIdsByTabId: { 'tab-1': ['pty-1'] }
    })

    store.getState().setAgentStatus('tab-1:0', {
      state: 'working',
      prompt: 'p',
      agentType: 'claude'
    })
    store.getState().acknowledgeAgents(['tab-1:0'])
    store.getState().retainAgents([
      {
        entry: {
          paneKey: 'tab-1:0',
          state: 'done',
          stateStartedAt: 1000,
          updatedAt: 1000,
          stateHistory: [],
          prompt: 'p',
          agentType: 'claude',
          terminalTitle: undefined,
          interrupted: false
        },
        worktreeId: wt,
        tab: makeTab({ id: 'tab-1', worktreeId: wt, title: 'Claude' }),
        agentType: 'claude',
        startedAt: 1000
      }
    ])

    // Default opts (no keepIdentifiers) => remove-worktree path.
    await store.getState().shutdownWorktreeTerminals(wt)

    const s = store.getState()
    expect(s.agentStatusByPaneKey['tab-1:0']).toBeUndefined()
    expect(s.retainedAgentsByPaneKey['tab-1:0']).toBeUndefined()
    expect(s.acknowledgedAgentsByPaneKey['tab-1:0']).toBeUndefined()
  })
})
