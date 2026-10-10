import { describe, it, expect, vi, beforeEach } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import { getDefaultSettings } from '../../../../shared/constants'
import { createCompatibleRuntimeStatusResponseIfNeeded } from '../../runtime/runtime-compatibility-test-fixture'
import {
  clearRuntimeCompatibilityCacheForTests,
  RuntimeRpcCallError
} from '../../runtime/runtime-rpc-client'
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

  it('records terminal input even before agent sleep is enabled', () => {
    const store = createTestStore()

    store.getState().recordTerminalInput('tab-1:leaf-1', 1000)

    expect(store.getState().lastTerminalInputAtByPaneKey['tab-1:leaf-1']).toBe(1000)
  })

  it('asks sleep-time buffer capture to skip local scrollback serialization', async () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'
    const capture = vi.fn()

    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      },
      tabsByWorktree: {
        [wt]: [makeTab({ id: 'tab-1', worktreeId: wt, ptyId: 'pty-1' })]
      },
      ptyIdsByTabId: { 'tab-1': ['pty-1'] }
    })
    shutdownBufferCaptures.set('tab-1', capture)

    await store.getState().shutdownWorktreeTerminals(wt, { keepIdentifiers: true })

    expect(capture).toHaveBeenCalledWith({ includeLocalBuffers: false })
  })

  it('does not stop the active runtime when sleeping an SSH-owned worktree', async () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'

    seedStore(store, {
      settings: { ...getDefaultSettings('/tmp'), activeRuntimeEnvironmentId: 'runtime-1' },
      repos: [
        {
          id: 'repo1',
          path: '/repo1',
          displayName: 'Repo 1',
          badgeColor: '#000',
          addedAt: 0,
          connectionId: 'ssh-1'
        }
      ],
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1', hostId: 'ssh:ssh-1' })]
      },
      tabsByWorktree: {
        [wt]: [makeTab({ id: 'tab-1', worktreeId: wt, ptyId: 'ssh:ssh-1@@pty-1' })]
      },
      ptyIdsByTabId: { 'tab-1': ['ssh:ssh-1@@pty-1'] }
    })

    await store.getState().shutdownWorktreeTerminals(wt, { keepIdentifiers: true })

    expect(mockApi.runtimeEnvironments.call).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: 'terminal.stop' })
    )
    expect(mockApi.runtimeEnvironments.call).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: 'terminal.sleep' })
    )
    expect(mockApi.pty.kill).toHaveBeenCalledWith('ssh:ssh-1@@pty-1', { keepHistory: true })
  })

  it('asks the owner runtime to converge a runtime-owned worktree', async () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'

    seedStore(store, {
      settings: { ...getDefaultSettings('/tmp'), activeRuntimeEnvironmentId: 'runtime-1' },
      worktreesByRepo: {
        repo1: [makeRuntimeOwnedWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      },
      tabsByWorktree: {
        [wt]: [makeTab({ id: 'tab-1', worktreeId: wt, ptyId: 'pty-1' })]
      },
      ptyIdsByTabId: { 'tab-1': ['pty-1'] }
    })

    await store.getState().shutdownWorktreeTerminals(wt, { keepIdentifiers: true })

    expect(mockApi.runtimeEnvironments.call).toHaveBeenCalledWith(
      expect.objectContaining({
        selector: 'runtime-1',
        method: 'terminal.sleep'
      })
    )
  })

  it('contacts the owner when the requesting client has no hydrated PTY ids', async () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'
    seedStore(store, {
      settings: { ...getDefaultSettings('/tmp'), activeRuntimeEnvironmentId: 'runtime-1' },
      worktreesByRepo: {
        repo1: [makeRuntimeOwnedWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      },
      tabsByWorktree: { [wt]: [makeTab({ id: 'tab-1', worktreeId: wt })] },
      ptyIdsByTabId: { 'tab-1': [] }
    })

    await store.getState().shutdownWorktreeTerminals(wt, { keepIdentifiers: true })

    expect(mockApi.runtimeEnvironments.call).toHaveBeenCalledWith(
      expect.objectContaining({ selector: 'runtime-1', method: 'terminal.sleep' })
    )
    expect(store.getState().ptyIdsByTabId['tab-1']).toEqual([])
  })

  it('keeps renderer sleep state retryable when the owner RPC fails', async () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'
    mockApi.runtimeEnvironments.call.mockImplementation((args: { method: string }) => {
      const compatible = createCompatibleRuntimeStatusResponseIfNeeded(args)
      if (compatible) {
        return Promise.resolve(compatible)
      }
      return args.method === 'terminal.sleep'
        ? Promise.reject(new Error('runtime graph unavailable'))
        : Promise.resolve({
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
      tabsByWorktree: { [wt]: [makeTab({ id: 'tab-1', worktreeId: wt })] },
      ptyIdsByTabId: { 'tab-1': ['remote:runtime-1@@pty-1'] }
    })
    store.getState().setAgentStatus('tab-1:leaf-1', {
      state: 'working',
      prompt: 'keep running',
      agentType: 'codex'
    })

    await expect(
      store.getState().shutdownWorktreeTerminals(wt, { keepIdentifiers: true })
    ).rejects.toThrow('runtime graph unavailable')

    expect(store.getState().ptyIdsByTabId['tab-1']).toEqual(['remote:runtime-1@@pty-1'])
    expect(store.getState().agentStatusByPaneKey['tab-1:leaf-1']).toBeDefined()
    expect(store.getState().suppressedPtyExitIds['remote:runtime-1@@pty-1']).toBeUndefined()
    expect(mockUnregisterPtyDataHandlers).toHaveBeenCalledWith(['remote:runtime-1@@pty-1'])
  })

  it('rejects an owner response that cannot prove physical convergence', async () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'
    mockApi.runtimeEnvironments.call.mockImplementation((args: { method: string }) =>
      Promise.resolve(
        createCompatibleRuntimeStatusResponseIfNeeded(args) ?? {
          id: 'rpc-default',
          ok: true,
          result:
            args.method === 'terminal.sleep'
              ? {
                  stopped: 1,
                  stoppedPtyIds: ['pty-1'],
                  livePtyIds: ['pty-1'],
                  postStopVerified: false,
                  postStopFailure: 'terminal_worktree_sleep_still_live',
                  remainingLivePtyIds: ['pty-1']
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
      tabsByWorktree: { [wt]: [makeTab({ id: 'tab-1', worktreeId: wt })] },
      ptyIdsByTabId: { 'tab-1': [] }
    })

    await expect(
      store.getState().shutdownWorktreeTerminals(wt, { keepIdentifiers: true })
    ).rejects.toThrow('terminal_worktree_sleep_still_live')
    expect(mockUnregisterPtyDataHandlers).toHaveBeenCalledWith([])
  })

  it.each([
    null,
    {},
    { postStopVerified: 'yes' },
    { postStopVerified: true, remainingLivePtyIds: 'pty-1' }
  ])('rejects malformed terminal.sleep response %#', async (sleepResult) => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'
    mockApi.runtimeEnvironments.call.mockImplementation((args: { method: string }) =>
      Promise.resolve(
        createCompatibleRuntimeStatusResponseIfNeeded(args) ?? {
          id: 'rpc-default',
          ok: true,
          result: args.method === 'terminal.sleep' ? sleepResult : {},
          _meta: { runtimeId: 'remote-runtime' }
        }
      )
    )
    seedStore(store, {
      settings: { ...getDefaultSettings('/tmp'), activeRuntimeEnvironmentId: 'runtime-1' },
      worktreesByRepo: {
        repo1: [makeRuntimeOwnedWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      },
      tabsByWorktree: { [wt]: [makeTab({ id: 'tab-1', worktreeId: wt })] },
      ptyIdsByTabId: { 'tab-1': [] }
    })

    await expect(
      store.getState().shutdownWorktreeTerminals(wt, { keepIdentifiers: true })
    ).rejects.toThrow(/terminal_worktree_sleep_(invalid_response|unverified)/)
    expect(mockUnregisterPtyDataHandlers).toHaveBeenCalledWith([])
  })

  it('defers owner exit mutation until failed sleep verification rolls back', async () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'
    const ptyId = 'remote:runtime-1@@pty-1'
    mockApi.runtimeEnvironments.call.mockImplementation((args: { method: string }) => {
      const compatible = createCompatibleRuntimeStatusResponseIfNeeded(args)
      if (compatible) {
        return Promise.resolve(compatible)
      }
      if (args.method === 'terminal.sleep') {
        expect(store.getState().pendingPtyShutdownIds[ptyId]).toBe(1)
        store.getState().clearTabPtyId('tab-1', ptyId)
        return Promise.resolve({
          id: 'rpc-sleep',
          ok: true,
          result: {
            stopped: 1,
            stoppedPtyIds: ['pty-1'],
            livePtyIds: ['pty-1'],
            postStopVerified: false,
            postStopFailure: 'terminal_worktree_sleep_still_live',
            remainingLivePtyIds: ['pty-1']
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
      tabsByWorktree: { [wt]: [makeTab({ id: 'tab-1', worktreeId: wt, ptyId })] },
      ptyIdsByTabId: { 'tab-1': [ptyId] }
    })

    await expect(
      store.getState().shutdownWorktreeTerminals(wt, { keepIdentifiers: true })
    ).rejects.toThrow('terminal_worktree_sleep_still_live')
    expect(store.getState().ptyIdsByTabId['tab-1']).toEqual([ptyId])
    expect(store.getState().tabsByWorktree[wt]?.[0]?.ptyId).toBe(ptyId)
    expect(store.getState().pendingPtyShutdownIds[ptyId]).toBeUndefined()
  })

  it('retains the exit guard until every concurrent renderer shutdown settles', async () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'
    const ptyId = 'remote:runtime-1@@pty-1'
    let rejectSleep = (_error: Error): void => {}
    const pendingSleep = new Promise<never>((_resolve, reject) => {
      rejectSleep = reject
    })
    let sleepCallCount = 0
    mockApi.runtimeEnvironments.call.mockImplementation((args: { method: string }) => {
      const compatible = createCompatibleRuntimeStatusResponseIfNeeded(args)
      if (compatible) {
        return Promise.resolve(compatible)
      }
      if (args.method === 'terminal.sleep') {
        sleepCallCount += 1
        return sleepCallCount === 1 ? Promise.reject(new Error('first owner failed')) : pendingSleep
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
      tabsByWorktree: { [wt]: [makeTab({ id: 'tab-1', worktreeId: wt, ptyId })] },
      ptyIdsByTabId: { 'tab-1': [ptyId] }
    })

    const first = store.getState().shutdownWorktreeTerminals(wt, { keepIdentifiers: true })
    const firstRejection = expect(first).rejects.toThrow('first owner failed')
    const second = store.getState().shutdownWorktreeTerminals(wt, { keepIdentifiers: true })
    await firstRejection
    expect(store.getState().pendingPtyShutdownIds[ptyId]).toBe(1)
    expect(store.getState().suppressedPtyExitIds[ptyId]).toBe(true)
    store.getState().clearTabPtyId('tab-1', ptyId)
    const secondRejection = expect(second).rejects.toThrow('owner timed out')
    rejectSleep(new Error('owner timed out'))

    await secondRejection
    expect(sleepCallCount).toBe(2)
    expect(store.getState().ptyIdsByTabId['tab-1']).toEqual([ptyId])
    expect(store.getState().pendingPtyShutdownIds[ptyId]).toBeUndefined()
  })

  it('falls back to terminal.stop only when an old runtime lacks terminal.sleep', async () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'
    mockApi.runtimeEnvironments.call.mockImplementation((args: { method: string }) => {
      const compatible = createCompatibleRuntimeStatusResponseIfNeeded(args)
      if (compatible) {
        return Promise.resolve(compatible)
      }
      if (args.method === 'terminal.sleep') {
        return Promise.reject(
          new RuntimeRpcCallError({
            id: 'rpc-sleep',
            ok: false,
            error: { code: 'method_not_found', message: 'Unknown method' },
            _meta: { runtimeId: 'old-runtime' }
          })
        )
      }
      if (args.method === 'terminal.list') {
        return Promise.resolve({
          id: 'rpc-list',
          ok: true,
          result: {
            terminals: [{ connected: true, ptyId: null }],
            totalCount: 1,
            truncated: false
          },
          _meta: { runtimeId: 'old-runtime' }
        })
      }
      return Promise.resolve({
        id: 'rpc-stop',
        ok: true,
        result: { stopped: 1 },
        _meta: { runtimeId: 'old-runtime' }
      })
    })
    seedStore(store, {
      settings: { ...getDefaultSettings('/tmp'), activeRuntimeEnvironmentId: 'runtime-1' },
      worktreesByRepo: {
        repo1: [makeRuntimeOwnedWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      },
      tabsByWorktree: { [wt]: [makeTab({ id: 'tab-1', worktreeId: wt })] },
      ptyIdsByTabId: { 'tab-1': [] }
    })

    await store.getState().shutdownWorktreeTerminals(wt, { keepIdentifiers: true })

    expect(mockApi.runtimeEnvironments.call).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'terminal.sleep' })
    )
    expect(mockApi.runtimeEnvironments.call).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'terminal.stop' })
    )
    expect(mockApi.runtimeEnvironments.call).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'terminal.list',
        params: expect.objectContaining({ requireFreshPtyLiveness: true })
      })
    )
  })

  it('waits for delayed legacy runtime teardown before committing sleep', async () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'
    let listCount = 0
    let stopCount = 0
    mockApi.runtimeEnvironments.call.mockImplementation((args: { method: string }) => {
      const compatible = createCompatibleRuntimeStatusResponseIfNeeded(args)
      if (compatible) {
        return Promise.resolve(compatible)
      }
      if (args.method === 'terminal.sleep') {
        return Promise.reject(
          new RuntimeRpcCallError({
            id: 'rpc-sleep',
            ok: false,
            error: { code: 'method_not_found', message: 'Unknown method' },
            _meta: { runtimeId: 'old-runtime' }
          })
        )
      }
      if (args.method === 'terminal.list') {
        listCount += 1
        return Promise.resolve({
          id: `rpc-list-${listCount}`,
          ok: true,
          result: {
            terminals:
              listCount === 1
                ? [{ connected: true, ptyId: 'pty-1' }]
                : [{ connected: true, ptyId: null }],
            totalCount: 1,
            truncated: false
          },
          _meta: { runtimeId: 'old-runtime' }
        })
      }
      if (args.method === 'terminal.stop') {
        stopCount += 1
      }
      return Promise.resolve({
        id: 'rpc-stop',
        ok: true,
        result: { stopped: 1 },
        _meta: { runtimeId: 'old-runtime' }
      })
    })
    seedStore(store, {
      settings: { ...getDefaultSettings('/tmp'), activeRuntimeEnvironmentId: 'runtime-1' },
      worktreesByRepo: {
        repo1: [makeRuntimeOwnedWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      },
      tabsByWorktree: { [wt]: [makeTab({ id: 'tab-1', worktreeId: wt })] },
      ptyIdsByTabId: { 'tab-1': [] }
    })

    await store.getState().shutdownWorktreeTerminals(wt, { keepIdentifiers: true })

    expect(listCount).toBe(2)
    expect(stopCount).toBe(2)
  })

  it('bounds the complete legacy fallback to one wall-clock deadline', async () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'
    let now = 1_000
    const dateNow = vi.spyOn(Date, 'now').mockImplementation(() => now)
    const observedTimeouts: { method: string; timeoutMs?: number }[] = []
    try {
      mockApi.runtimeEnvironments.call.mockImplementation(
        (args: { method: string; timeoutMs?: number }) => {
          const compatible = createCompatibleRuntimeStatusResponseIfNeeded(args)
          if (compatible) {
            return Promise.resolve(compatible)
          }
          observedTimeouts.push({ method: args.method, timeoutMs: args.timeoutMs })
          if (args.method === 'terminal.sleep') {
            return Promise.reject(
              new RuntimeRpcCallError({
                id: 'rpc-sleep',
                ok: false,
                error: { code: 'method_not_found', message: 'Unknown method' },
                _meta: { runtimeId: 'old-runtime' }
              })
            )
          }
          now += 6_000
          if (args.method === 'terminal.list') {
            return Promise.resolve({
              id: 'rpc-list',
              ok: true,
              result: {
                terminals: [{ connected: true, ptyId: 'pty-discovered' }],
                totalCount: 1,
                truncated: false
              },
              _meta: { runtimeId: 'old-runtime' }
            })
          }
          return Promise.resolve({
            id: 'rpc-stop',
            ok: true,
            result: { stopped: 1 },
            _meta: { runtimeId: 'old-runtime' }
          })
        }
      )
      seedStore(store, {
        settings: { ...getDefaultSettings('/tmp'), activeRuntimeEnvironmentId: 'runtime-1' },
        worktreesByRepo: {
          repo1: [makeRuntimeOwnedWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
        },
        tabsByWorktree: { [wt]: [makeTab({ id: 'tab-1', worktreeId: wt })] },
        ptyIdsByTabId: { 'tab-1': [] }
      })

      await expect(
        store.getState().shutdownWorktreeTerminals(wt, { keepIdentifiers: true })
      ).rejects.toThrow('terminal_worktree_sleep_legacy_unverified')

      expect(observedTimeouts.filter(({ method }) => method === 'terminal.stop')).toEqual([
        { method: 'terminal.stop', timeoutMs: 15_000 },
        { method: 'terminal.stop', timeoutMs: 3_000 }
      ])
      expect(observedTimeouts.filter(({ method }) => method === 'terminal.list')).toEqual([
        { method: 'terminal.list', timeoutMs: 5_000 }
      ])
    } finally {
      dateNow.mockRestore()
    }
  })

  it('keeps legacy sleep retryable when fresh listing is truncated or malformed', async () => {
    vi.useFakeTimers()
    try {
      const store = createTestStore()
      const wt = 'repo1::/path/wt1'
      let listCount = 0
      mockApi.runtimeEnvironments.call.mockImplementation((args: { method: string }) => {
        const compatible = createCompatibleRuntimeStatusResponseIfNeeded(args)
        if (compatible) {
          return Promise.resolve(compatible)
        }
        if (args.method === 'terminal.sleep') {
          return Promise.reject(
            new RuntimeRpcCallError({
              id: 'rpc-sleep',
              ok: false,
              error: { code: 'method_not_found', message: 'Unknown method' },
              _meta: { runtimeId: 'old-runtime' }
            })
          )
        }
        if (args.method === 'terminal.list') {
          listCount += 1
          return Promise.resolve({
            id: `rpc-list-${listCount}`,
            ok: true,
            result:
              listCount <= 4
                ? {
                    terminals: [{ connected: true, ptyId: null }],
                    totalCount: 2,
                    truncated: true
                  }
                : { terminals: [{}], totalCount: 1, truncated: false },
            _meta: { runtimeId: 'old-runtime' }
          })
        }
        return Promise.resolve({
          id: 'rpc-stop',
          ok: true,
          result: { stopped: 1 },
          _meta: { runtimeId: 'old-runtime' }
        })
      })
      seedStore(store, {
        settings: { ...getDefaultSettings('/tmp'), activeRuntimeEnvironmentId: 'runtime-1' },
        worktreesByRepo: {
          repo1: [makeRuntimeOwnedWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
        },
        tabsByWorktree: { [wt]: [makeTab({ id: 'tab-1', worktreeId: wt })] },
        ptyIdsByTabId: { 'tab-1': [] }
      })

      const sleep = store.getState().shutdownWorktreeTerminals(wt, { keepIdentifiers: true })
      const rejection = expect(sleep).rejects.toThrow('terminal_worktree_sleep_legacy_unverified')
      await vi.runAllTimersAsync()
      await rejection

      expect(listCount).toBe(8)
      expect(mockUnregisterPtyDataHandlers).toHaveBeenCalledWith([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not fall back for non-compatibility runtime sleep failures', async () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'
    mockApi.runtimeEnvironments.call.mockImplementation((args: { method: string }) => {
      const compatible = createCompatibleRuntimeStatusResponseIfNeeded(args)
      if (compatible) {
        return Promise.resolve(compatible)
      }
      return Promise.reject(
        new RuntimeRpcCallError({
          id: 'rpc-sleep',
          ok: false,
          error: { code: 'terminal_liveness_unavailable', message: 'Daemon unavailable' },
          _meta: { runtimeId: 'runtime-1' }
        })
      )
    })
    seedStore(store, {
      settings: { ...getDefaultSettings('/tmp'), activeRuntimeEnvironmentId: 'runtime-1' },
      worktreesByRepo: {
        repo1: [makeRuntimeOwnedWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      },
      tabsByWorktree: { [wt]: [makeTab({ id: 'tab-1', worktreeId: wt })] },
      ptyIdsByTabId: { 'tab-1': [] }
    })

    await expect(
      store.getState().shutdownWorktreeTerminals(wt, { keepIdentifiers: true })
    ).rejects.toThrow('Daemon unavailable')
    expect(mockApi.runtimeEnvironments.call).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: 'terminal.stop' })
    )
  })

  it('rolls back renderer teardown when a local physical PTY kill rejects', async () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'
    const handlerSnapshots = [{ ptyId: 'pty-1', dataHandler: vi.fn() }]
    mockUnregisterPtyDataHandlers.mockReturnValueOnce(handlerSnapshots)
    mockApi.pty.kill.mockRejectedValueOnce(new Error('physical stop failed'))
    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      },
      tabsByWorktree: { [wt]: [makeTab({ id: 'tab-1', worktreeId: wt })] },
      ptyIdsByTabId: { 'tab-1': ['pty-1'] }
    })
    store.getState().setAgentStatus('tab-1:leaf-1', {
      state: 'working',
      prompt: 'still live',
      agentType: 'codex'
    })

    await expect(
      store.getState().shutdownWorktreeTerminals(wt, { keepIdentifiers: true })
    ).rejects.toThrow('physical stop failed')

    expect(mockRestorePtyDataHandlersAfterFailedShutdown).toHaveBeenCalledWith(handlerSnapshots)
    expect(store.getState().ptyIdsByTabId['tab-1']).toEqual(['pty-1'])
    expect(store.getState().agentStatusByPaneKey['tab-1:leaf-1']).toBeDefined()
    expect(store.getState().suppressedPtyExitIds['pty-1']).toBeUndefined()
  })

  it('waits for sibling local PTY kills before rolling back a failed shutdown', async () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'
    let resolveSlowKill = (): void => {}
    const slowKill = new Promise<void>((resolve) => {
      resolveSlowKill = resolve
    })
    const handlerSnapshots = [
      { ptyId: 'pty-fails', dataHandler: vi.fn() },
      { ptyId: 'pty-slow', dataHandler: vi.fn() }
    ]
    mockUnregisterPtyDataHandlers.mockReturnValueOnce(handlerSnapshots)
    mockApi.pty.kill.mockImplementation((ptyId: string) =>
      ptyId === 'pty-fails' ? Promise.reject(new Error('physical stop failed')) : slowKill
    )
    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      },
      tabsByWorktree: { [wt]: [makeTab({ id: 'tab-1', worktreeId: wt })] },
      ptyIdsByTabId: { 'tab-1': ['pty-fails', 'pty-slow'] }
    })

    const shutdown = store.getState().shutdownWorktreeTerminals(wt, { keepIdentifiers: true })
    const rejection = expect(shutdown).rejects.toThrow('physical stop failed')
    await vi.waitFor(() => expect(mockApi.pty.kill).toHaveBeenCalledTimes(2))
    expect(mockRestorePtyDataHandlersAfterFailedShutdown).not.toHaveBeenCalled()
    expect(store.getState().pendingPtyShutdownIds['pty-slow']).toBe(1)

    resolveSlowKill()
    await rejection

    expect(mockRestorePtyDataHandlersAfterFailedShutdown).toHaveBeenCalledWith([
      handlerSnapshots[0]
    ])
    expect(store.getState().ptyIdsByTabId['tab-1']).toEqual(['pty-fails'])
    expect(store.getState().suppressedPtyExitIds['pty-slow']).toBe(true)
    expect(store.getState().suppressedPtyExitIds['pty-fails']).toBeUndefined()
    expect(store.getState().pendingPtyShutdownIds['pty-slow']).toBeUndefined()
  })

  it('stops the explicit owner runtime when another host is focused', async () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'

    seedStore(store, {
      settings: { ...getDefaultSettings('/tmp'), activeRuntimeEnvironmentId: 'focused-runtime' },
      repos: [
        {
          id: 'repo1',
          path: '/path/repo1',
          displayName: 'Repo 1',
          badgeColor: '#000',
          addedAt: 0,
          executionHostId: 'runtime:owner-runtime'
        }
      ],
      worktreesByRepo: {
        repo1: [
          makeRuntimeOwnedWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' }, 'owner-runtime')
        ]
      },
      tabsByWorktree: {
        [wt]: [makeTab({ id: 'tab-1', worktreeId: wt, ptyId: 'pty-1' })]
      },
      ptyIdsByTabId: { 'tab-1': ['pty-1'] }
    })

    await store.getState().shutdownWorktreeTerminals(wt, { keepIdentifiers: true })

    expect(mockApi.runtimeEnvironments.call).toHaveBeenCalledWith(
      expect.objectContaining({
        selector: 'owner-runtime',
        method: 'terminal.sleep'
      })
    )
    expect(mockApi.runtimeEnvironments.call).not.toHaveBeenCalledWith(
      expect.objectContaining({
        selector: 'focused-runtime',
        method: 'terminal.sleep'
      })
    )
  })
})
