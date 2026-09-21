import { describe, it, expect, vi, beforeEach } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import { getDefaultSettings } from '../../../../shared/constants'
import { createCompatibleRuntimeStatusResponseIfNeeded } from '../../runtime/runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCacheForTests } from '../../runtime/runtime-rpc-client'
import {
  createTestStore,
  makeRuntimeOwnedWorktree,
  makeTab,
  makeWorktree,
  seedStore
} from './store-test-helpers'
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

  it('commits sleep state after exact runtime stop for runtime-backed PTYs', async () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'
    const now = Date.now()
    mockApi.runtimeEnvironments.call.mockImplementation((args: { method: string }) =>
      Promise.resolve(
        createCompatibleRuntimeStatusResponseIfNeeded(args) ?? {
          id: 'rpc-default',
          ok: true,
          result:
            args.method === 'terminal.stopExact'
              ? { stoppedPtyIds: ['pty-1'], livePtyIds: ['pty-1'], postStopVerified: true }
              : {},
          _meta: { runtimeId: 'remote-runtime' }
        }
      )
    )

    seedStore(store, {
      settings: { ...getDefaultSettings('/tmp'), activeRuntimeEnvironmentId: 'runtime-1' },
      worktreesByRepo: {
        repo1: [makeRuntimeOwnedWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      },
      tabsByWorktree: {
        [wt]: [makeTab({ id: 'tab-1', worktreeId: wt, title: 'Codex' })]
      },
      ptyIdsByTabId: { 'tab-1': [] }
    })
    store.getState().setAgentStatus(
      'tab-1:live',
      {
        state: 'working',
        prompt: 'resume live',
        agentType: 'codex'
      },
      'Codex',
      { updatedAt: now, stateStartedAt: now },
      { tabId: 'tab-1', worktreeId: wt },
      { providerSession: { key: 'session_id', id: 'live-session' } }
    )

    await store.getState().shutdownWorktreeTerminals(wt, {
      keepIdentifiers: true,
      sleepingPaneKeys: ['tab-1:live'],
      expectedRuntimePtyIds: ['pty-1']
    })

    expect(mockApi.runtimeEnvironments.call).toHaveBeenCalledWith(
      expect.objectContaining({
        selector: 'runtime-1',
        method: 'terminal.stopExact',
        params: expect.objectContaining({ expectedPtyIds: ['pty-1'], keepHistory: true })
      })
    )
    expect(store.getState().sleepingAgentSessionsByPaneKey['tab-1:live']).toMatchObject({
      origin: 'worktree-sleep',
      providerSession: { key: 'session_id', id: 'live-session' }
    })
    expect(store.getState().agentStatusByPaneKey['tab-1:live']).toBeUndefined()
    expect(mockApi.pty.kill).not.toHaveBeenCalled()
  })

  it('does not commit sleep state when exact runtime stop post-check is inconclusive', async () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'
    mockApi.runtimeEnvironments.call.mockImplementation((args: { method: string }) =>
      Promise.resolve(
        createCompatibleRuntimeStatusResponseIfNeeded(args) ?? {
          id: 'rpc-default',
          ok: true,
          result:
            args.method === 'terminal.stopExact'
              ? {
                  stoppedPtyIds: ['pty-1'],
                  livePtyIds: ['pty-1'],
                  postStopVerified: false,
                  postStopFailure: 'terminal_liveness_unavailable'
                }
              : {},
          _meta: { runtimeId: 'remote-runtime' }
        }
      )
    )

    seedStore(store, {
      settings: { ...getDefaultSettings('/tmp'), activeRuntimeEnvironmentId: 'runtime-1' },
      worktreesByRepo: {
        repo1: [makeRuntimeOwnedWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      },
      tabsByWorktree: {
        [wt]: [makeTab({ id: 'tab-1', worktreeId: wt, title: 'Codex' })]
      },
      ptyIdsByTabId: { 'tab-1': [] }
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

    await expect(
      store.getState().shutdownWorktreeTerminals(wt, {
        keepIdentifiers: true,
        sleepingPaneKeys: ['tab-1:live'],
        expectedRuntimePtyIds: ['pty-1']
      })
    ).rejects.toThrow('terminal_liveness_unavailable')

    // Why: done resumable agent keeps its origin:'live' anchor (#9454); an inconclusive stop rolls back to it, not undefined, and never commits worktree-sleep.
    expect(store.getState().sleepingAgentSessionsByPaneKey['tab-1:live']).toMatchObject({
      origin: 'live',
      agent: 'codex',
      providerSession: { key: 'session_id', id: 'live-session' }
    })
    expect(store.getState().agentStatusByPaneKey['tab-1:live']).toBeDefined()
    expect(store.getState().suppressedPtyExitIds['pty-1']).toBeUndefined()
    expect(mockApi.pty.kill).not.toHaveBeenCalled()
  })

  it('does not commit sleep state when exact runtime stop omits post-check proof', async () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'
    mockApi.runtimeEnvironments.call.mockImplementation((args: { method: string }) =>
      Promise.resolve(
        createCompatibleRuntimeStatusResponseIfNeeded(args) ?? {
          id: 'rpc-default',
          ok: true,
          result:
            args.method === 'terminal.stopExact'
              ? { stoppedPtyIds: ['pty-1'], livePtyIds: ['pty-1'] }
              : {},
          _meta: { runtimeId: 'remote-runtime' }
        }
      )
    )

    seedStore(store, {
      settings: { ...getDefaultSettings('/tmp'), activeRuntimeEnvironmentId: 'runtime-1' },
      worktreesByRepo: {
        repo1: [makeRuntimeOwnedWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      },
      tabsByWorktree: {
        [wt]: [makeTab({ id: 'tab-1', worktreeId: wt, title: 'Codex' })]
      },
      ptyIdsByTabId: { 'tab-1': [] }
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

    await expect(
      store.getState().shutdownWorktreeTerminals(wt, {
        keepIdentifiers: true,
        sleepingPaneKeys: ['tab-1:live'],
        expectedRuntimePtyIds: ['pty-1']
      })
    ).rejects.toThrow('exact_terminal_stop_unverified')

    // Why: done resumable agent keeps its origin:'live' anchor (#9454); an unverified stop rolls back to it, not undefined, and never commits worktree-sleep.
    expect(store.getState().sleepingAgentSessionsByPaneKey['tab-1:live']).toMatchObject({
      origin: 'live',
      agent: 'codex',
      providerSession: { key: 'session_id', id: 'live-session' }
    })
    expect(store.getState().agentStatusByPaneKey['tab-1:live']).toBeDefined()
    expect(store.getState().suppressedPtyExitIds['pty-1']).toBeUndefined()
    expect(mockApi.pty.kill).not.toHaveBeenCalled()
  })

  it('clears exact-stop exit suppression when a slept PTY ID wakes live again', async () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'
    mockApi.runtimeEnvironments.call.mockImplementation((args: { method: string }) =>
      Promise.resolve(
        createCompatibleRuntimeStatusResponseIfNeeded(args) ?? {
          id: 'rpc-default',
          ok: true,
          result:
            args.method === 'terminal.stopExact'
              ? { stoppedPtyIds: ['pty-1'], livePtyIds: ['pty-1'], postStopVerified: true }
              : {},
          _meta: { runtimeId: 'remote-runtime' }
        }
      )
    )

    seedStore(store, {
      settings: { ...getDefaultSettings('/tmp'), activeRuntimeEnvironmentId: 'runtime-1' },
      worktreesByRepo: {
        repo1: [makeRuntimeOwnedWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      },
      tabsByWorktree: {
        [wt]: [makeTab({ id: 'tab-1', worktreeId: wt, title: 'Codex' })]
      },
      ptyIdsByTabId: { 'tab-1': ['remote:runtime-1@@pty-1'] }
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

    await store.getState().shutdownWorktreeTerminals(wt, {
      keepIdentifiers: true,
      sleepingPaneKeys: ['tab-1:live'],
      expectedRuntimePtyIds: ['pty-1']
    })
    expect(store.getState().suppressedPtyExitIds['remote:runtime-1@@pty-1']).toBe(true)
    expect(store.getState().suppressedPtyExitIds['pty-1']).toBeUndefined()

    store.getState().updateTabPtyId('tab-1', 'remote:runtime-1@@pty-1')

    expect(store.getState().suppressedPtyExitIds['remote:runtime-1@@pty-1']).toBeUndefined()
  })

  it('suppresses only the scoped remote PTY identity before exact runtime stop resolves', async () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'
    let sawWrappedSuppressedDuringStop = false
    let sawRawSuppressedDuringStop = false
    mockApi.runtimeEnvironments.call.mockImplementation((args: { method: string }) => {
      const compatible = createCompatibleRuntimeStatusResponseIfNeeded(args)
      if (compatible) {
        return Promise.resolve(compatible)
      }
      if (args.method === 'terminal.stopExact') {
        sawWrappedSuppressedDuringStop = store
          .getState()
          .consumeSuppressedPtyExit('remote:env-1@@terminal-1')
        sawRawSuppressedDuringStop = store.getState().consumeSuppressedPtyExit('terminal-1')
        return Promise.resolve({
          id: 'rpc-default',
          ok: true,
          result: {
            stoppedPtyIds: ['terminal-1'],
            livePtyIds: ['terminal-1'],
            postStopVerified: true
          },
          _meta: { runtimeId: 'remote-runtime' }
        })
      }
      return Promise.resolve({
        id: 'rpc-default',
        ok: true,
        result: {},
        _meta: { runtimeId: 'remote-runtime' }
      })
    })

    seedStore(store, {
      settings: { ...getDefaultSettings('/tmp'), activeRuntimeEnvironmentId: 'runtime-1' },
      worktreesByRepo: {
        repo1: [makeRuntimeOwnedWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      },
      tabsByWorktree: {
        [wt]: [makeTab({ id: 'tab-1', worktreeId: wt, title: 'Codex' })]
      },
      ptyIdsByTabId: { 'tab-1': ['remote:env-1@@terminal-1'] }
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

    await store.getState().shutdownWorktreeTerminals(wt, {
      keepIdentifiers: true,
      sleepingPaneKeys: ['tab-1:live'],
      expectedRuntimePtyIds: ['terminal-1']
    })

    expect(sawWrappedSuppressedDuringStop).toBe(true)
    expect(store.getState().suppressedPtyExitIds['remote:runtime-1@@terminal-1']).toBeUndefined()
    expect(sawRawSuppressedDuringStop).toBe(false)
    expect(mockUnregisterPtyDataHandlers).toHaveBeenCalledWith(['remote:env-1@@terminal-1'])
    expect(mockUnregisterPtyDataHandlers).not.toHaveBeenCalledWith(['terminal-1'])
  })

  it('still kills a local renderer PTY whose id matches a remote exact-stop handle', async () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'
    mockApi.runtimeEnvironments.call.mockImplementation((args: { method: string }) =>
      Promise.resolve(
        createCompatibleRuntimeStatusResponseIfNeeded(args) ?? {
          id: 'rpc-default',
          ok: true,
          result:
            args.method === 'terminal.stopExact'
              ? {
                  stoppedPtyIds: ['terminal-1'],
                  livePtyIds: ['terminal-1'],
                  postStopVerified: true
                }
              : {},
          _meta: { runtimeId: 'remote-runtime' }
        }
      )
    )
    seedStore(store, {
      settings: { ...getDefaultSettings('/tmp'), activeRuntimeEnvironmentId: 'runtime-1' },
      worktreesByRepo: {
        repo1: [makeRuntimeOwnedWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      },
      tabsByWorktree: {
        [wt]: [makeTab({ id: 'tab-1', worktreeId: wt })]
      },
      ptyIdsByTabId: {
        'tab-1': ['remote:runtime-1@@terminal-1', 'terminal-1']
      }
    })

    await store.getState().shutdownWorktreeTerminals(wt, {
      expectedRuntimePtyIds: ['terminal-1']
    })

    expect(mockApi.pty.kill).toHaveBeenCalledWith('terminal-1', { keepHistory: false })
    expect(mockUnregisterPtyDataHandlers).toHaveBeenCalledWith([
      'remote:runtime-1@@terminal-1',
      'terminal-1'
    ])
  })

  it('does not consume a colliding raw PTY guard when a scoped remote PTY wakes', () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'

    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      },
      tabsByWorktree: {
        [wt]: [makeTab({ id: 'tab-1', worktreeId: wt, title: 'Codex' })]
      },
      ptyIdsByTabId: { 'tab-1': [] }
    })
    store.getState().suppressPtyExit('remote:env-1@@terminal-1')
    store.getState().suppressPtyExit('terminal-1')

    store.getState().updateTabPtyId('tab-1', 'remote:env-1@@terminal-1')

    expect(store.getState().suppressedPtyExitIds['remote:env-1@@terminal-1']).toBeUndefined()
    expect(store.getState().suppressedPtyExitIds['terminal-1']).toBe(true)
  })

  it('migrates legacy remote lifecycle state to the scoped PTY identity on attach', () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'
    const legacyPtyId = 'remote:terminal-1'
    const scopedPtyId = 'remote:env-1@@terminal-1'
    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      },
      tabsByWorktree: {
        [wt]: [makeTab({ id: 'tab-1', worktreeId: wt, ptyId: legacyPtyId })]
      },
      ptyIdsByTabId: { 'tab-1': [legacyPtyId] },
      suppressedPtyExitIds: { [legacyPtyId]: true },
      pendingCodexPaneRestartIds: { [legacyPtyId]: true },
      codexRestartNoticeByPtyId: {
        [legacyPtyId]: { previousAccountLabel: 'old', nextAccountLabel: 'new' }
      },
      migrationUnsupportedByPtyId: {
        [legacyPtyId]: {
          ptyId: legacyPtyId,
          paneKey: 'tab-1:leaf-1',
          reason: 'legacy-numeric-pane-key',
          source: 'local',
          updatedAt: 1
        }
      }
    })

    store.getState().updateTabPtyId('tab-1', scopedPtyId)
    const state = store.getState()

    expect(state.ptyIdsByTabId['tab-1']).toEqual([scopedPtyId])
    expect(state.tabsByWorktree[wt][0]?.ptyId).toBe(scopedPtyId)
    expect(state.suppressedPtyExitIds[legacyPtyId]).toBeUndefined()
    expect(state.suppressedPtyExitIds[scopedPtyId]).toBeUndefined()
    expect(state.pendingCodexPaneRestartIds).toEqual({ [scopedPtyId]: true })
    expect(state.codexRestartNoticeByPtyId[scopedPtyId]).toEqual({
      previousAccountLabel: 'old',
      nextAccountLabel: 'new'
    })
    expect(state.migrationUnsupportedByPtyId[scopedPtyId]?.ptyId).toBe(scopedPtyId)
  })

  it('commits the pre-stop sleeping record when exact-stop exit clears live status', async () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'
    const now = Date.now()
    mockApi.runtimeEnvironments.call.mockImplementation((args: { method: string }) => {
      if (args.method === 'terminal.stopExact') {
        store.getState().removeAgentStatus('tab-1:live')
        return Promise.resolve({
          id: 'rpc-default',
          ok: true,
          result: { stoppedPtyIds: ['pty-1'], livePtyIds: ['pty-1'], postStopVerified: true },
          _meta: { runtimeId: 'remote-runtime' }
        })
      }
      return Promise.resolve(
        createCompatibleRuntimeStatusResponseIfNeeded(args) ?? {
          id: 'rpc-default',
          ok: true,
          result: {},
          _meta: { runtimeId: 'remote-runtime' }
        }
      )
    })

    seedStore(store, {
      settings: { ...getDefaultSettings('/tmp'), activeRuntimeEnvironmentId: 'runtime-1' },
      worktreesByRepo: {
        repo1: [makeRuntimeOwnedWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      },
      tabsByWorktree: {
        [wt]: [makeTab({ id: 'tab-1', worktreeId: wt, title: 'Codex' })]
      },
      ptyIdsByTabId: { 'tab-1': [] }
    })
    store.getState().setAgentStatus(
      'tab-1:live',
      {
        state: 'working',
        prompt: 'resume live',
        agentType: 'codex'
      },
      'Codex',
      { updatedAt: now, stateStartedAt: now },
      { tabId: 'tab-1', worktreeId: wt },
      { providerSession: { key: 'session_id', id: 'live-session' } }
    )

    await store.getState().shutdownWorktreeTerminals(wt, {
      keepIdentifiers: true,
      sleepingPaneKeys: ['tab-1:live'],
      expectedRuntimePtyIds: ['pty-1']
    })

    expect(store.getState().sleepingAgentSessionsByPaneKey['tab-1:live']).toMatchObject({
      origin: 'worktree-sleep',
      providerSession: { key: 'session_id', id: 'live-session' }
    })
  })

  it('commits pre-stop retained evidence when exact-stop clears live status during hibernation', async () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'
    mockApi.runtimeEnvironments.call.mockImplementation((args: { method: string }) => {
      if (args.method === 'terminal.stopExact') {
        store.getState().removeAgentStatus('tab-1:live')
        return Promise.resolve({
          id: 'rpc-default',
          ok: true,
          result: { stoppedPtyIds: ['pty-1'], livePtyIds: ['pty-1'], postStopVerified: true },
          _meta: { runtimeId: 'remote-runtime' }
        })
      }
      return Promise.resolve(
        createCompatibleRuntimeStatusResponseIfNeeded(args) ?? {
          id: 'rpc-default',
          ok: true,
          result: {},
          _meta: { runtimeId: 'remote-runtime' }
        }
      )
    })

    seedStore(store, {
      settings: { ...getDefaultSettings('/tmp'), activeRuntimeEnvironmentId: 'runtime-1' },
      worktreesByRepo: {
        repo1: [makeRuntimeOwnedWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      },
      tabsByWorktree: {
        [wt]: [makeTab({ id: 'tab-1', worktreeId: wt, title: 'Codex' })]
      },
      ptyIdsByTabId: { 'tab-1': [] }
    })
    store.getState().setAgentStatus(
      'tab-1:live',
      {
        state: 'done',
        prompt: 'resume live',
        agentType: 'codex',
        lastAssistantMessage: 'done'
      },
      'Codex',
      { updatedAt: 1000, stateStartedAt: 1000 },
      { tabId: 'tab-1', worktreeId: wt },
      { providerSession: { key: 'session_id', id: 'live-session' } }
    )

    await store.getState().shutdownWorktreeTerminals(wt, {
      keepIdentifiers: true,
      shutdownReason: 'auto-hibernate-completed-agent',
      sleepingPaneKeys: ['tab-1:live'],
      expectedRuntimePtyIds: ['pty-1']
    })

    expect(store.getState().agentStatusByPaneKey['tab-1:live']).toBeUndefined()
    expect(store.getState().retainedAgentsByPaneKey['tab-1:live']).toMatchObject({
      worktreeId: wt,
      entry: {
        prompt: 'resume live',
        lastAssistantMessage: 'done',
        providerSession: { key: 'session_id', id: 'live-session' }
      }
    })
  })

  it('does not commit stale pre-stop evidence when exact-stop changes live status', async () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'
    mockApi.runtimeEnvironments.call.mockImplementation((args: { method: string }) => {
      if (args.method === 'terminal.stopExact') {
        store.getState().setAgentStatus(
          'tab-1:live',
          {
            state: 'working',
            prompt: 'still active',
            agentType: 'codex'
          },
          'Codex',
          { updatedAt: 1500, stateStartedAt: 1500 },
          { tabId: 'tab-1', worktreeId: wt },
          { providerSession: { key: 'session_id', id: 'live-session' } }
        )
        return Promise.resolve({
          id: 'rpc-default',
          ok: true,
          result: { stoppedPtyIds: ['pty-1'], livePtyIds: ['pty-1'], postStopVerified: true },
          _meta: { runtimeId: 'remote-runtime' }
        })
      }
      return Promise.resolve(
        createCompatibleRuntimeStatusResponseIfNeeded(args) ?? {
          id: 'rpc-default',
          ok: true,
          result: {},
          _meta: { runtimeId: 'remote-runtime' }
        }
      )
    })

    seedStore(store, {
      settings: { ...getDefaultSettings('/tmp'), activeRuntimeEnvironmentId: 'runtime-1' },
      worktreesByRepo: {
        repo1: [makeRuntimeOwnedWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      },
      tabsByWorktree: {
        [wt]: [makeTab({ id: 'tab-1', worktreeId: wt, title: 'Codex' })]
      },
      ptyIdsByTabId: { 'tab-1': [] }
    })
    store.getState().setAgentStatus(
      'tab-1:live',
      {
        state: 'done',
        prompt: 'stale done',
        agentType: 'codex'
      },
      'Codex',
      { updatedAt: 1000, stateStartedAt: 1000 },
      { tabId: 'tab-1', worktreeId: wt },
      { providerSession: { key: 'session_id', id: 'live-session' } }
    )

    await store.getState().shutdownWorktreeTerminals(wt, {
      keepIdentifiers: true,
      shutdownReason: 'auto-hibernate-completed-agent',
      sleepingPaneKeys: ['tab-1:live'],
      expectedRuntimePtyIds: ['pty-1']
    })

    expect(store.getState().agentStatusByPaneKey['tab-1:live']).toBeUndefined()
    expect(store.getState().retainedAgentsByPaneKey['tab-1:live']).toBeUndefined()
    expect(store.getState().retentionSuppressedPaneKeys['tab-1:live']).toBe(true)
  })

  it('does not commit sleep state when exact runtime stop fails', async () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'
    mockApi.runtimeEnvironments.call.mockImplementation((args: { method: string }) => {
      const compatible = createCompatibleRuntimeStatusResponseIfNeeded(args)
      if (compatible) {
        return Promise.resolve(compatible)
      }
      if (args.method === 'terminal.stopExact') {
        return Promise.reject(new Error('stop failed'))
      }
      return Promise.resolve({
        id: 'rpc-default',
        ok: true,
        result: {},
        _meta: { runtimeId: 'remote-runtime' }
      })
    })

    seedStore(store, {
      settings: { ...getDefaultSettings('/tmp'), activeRuntimeEnvironmentId: 'runtime-1' },
      worktreesByRepo: {
        repo1: [makeRuntimeOwnedWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      },
      tabsByWorktree: {
        [wt]: [makeTab({ id: 'tab-1', worktreeId: wt, title: 'Codex' })]
      },
      ptyIdsByTabId: { 'tab-1': [] }
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

    await expect(
      store.getState().shutdownWorktreeTerminals(wt, {
        keepIdentifiers: true,
        sleepingPaneKeys: ['tab-1:live'],
        expectedRuntimePtyIds: ['pty-1']
      })
    ).rejects.toThrow('stop failed')

    // Why: done resumable agent keeps its origin:'live' anchor (#9454); a failed stop rolls back to it, not undefined, and never commits worktree-sleep.
    expect(store.getState().sleepingAgentSessionsByPaneKey['tab-1:live']).toMatchObject({
      origin: 'live',
      agent: 'codex',
      providerSession: { key: 'session_id', id: 'live-session' }
    })
    expect(store.getState().agentStatusByPaneKey['tab-1:live']).toBeDefined()
    expect(mockUnregisterPtyDataHandlers).not.toHaveBeenCalledWith(['pty-1'])
    expect(mockApi.pty.kill).not.toHaveBeenCalled()
  })

  it('does not commit sleep state when exact runtime stop returns the wrong set', async () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'
    mockApi.runtimeEnvironments.call.mockImplementation((args: { method: string }) =>
      Promise.resolve(
        createCompatibleRuntimeStatusResponseIfNeeded(args) ?? {
          id: 'rpc-default',
          ok: true,
          result:
            args.method === 'terminal.stopExact'
              ? {
                  stoppedPtyIds: ['pty-1'],
                  livePtyIds: ['pty-1', 'pty-shell'],
                  postStopVerified: true
                }
              : {},
          _meta: { runtimeId: 'remote-runtime' }
        }
      )
    )

    seedStore(store, {
      settings: { ...getDefaultSettings('/tmp'), activeRuntimeEnvironmentId: 'runtime-1' },
      worktreesByRepo: {
        repo1: [makeRuntimeOwnedWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      },
      tabsByWorktree: {
        [wt]: [makeTab({ id: 'tab-1', worktreeId: wt, title: 'Codex' })]
      },
      ptyIdsByTabId: { 'tab-1': [] }
    })
    store.getState().setAgentStatus('tab-1:live', {
      state: 'done',
      prompt: 'resume live',
      agentType: 'codex'
    })

    await expect(
      store.getState().shutdownWorktreeTerminals(wt, {
        keepIdentifiers: true,
        sleepingPaneKeys: ['tab-1:live'],
        expectedRuntimePtyIds: ['pty-1']
      })
    ).rejects.toThrow('exact_terminal_stop_mismatch')

    expect(store.getState().sleepingAgentSessionsByPaneKey['tab-1:live']).toBeUndefined()
    expect(store.getState().agentStatusByPaneKey['tab-1:live']).toBeDefined()
    expect(mockApi.pty.kill).not.toHaveBeenCalled()
  })
})
