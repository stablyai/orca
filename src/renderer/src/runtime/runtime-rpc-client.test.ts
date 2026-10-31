import { describe, expect, it, vi } from 'vitest'
import { callRuntimeRpc, clearRecentRuntimeCompatibilityFailure } from './runtime-rpc-client'
import { RuntimeRpcCallError, unwrapRuntimeRpcResult } from './runtime-rpc-result'
import {
  MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
  RUNTIME_PROTOCOL_VERSION
} from '../../../shared/protocol-version'
import {
  ORCA_RUNTIME_RPC_BROWSER_UI_SOURCE,
  ORCA_RUNTIME_RPC_FEATURE_INTERACTION_SOURCE_KEY
} from '../../../shared/runtime-rpc-feature-interaction-source'

import {
  installRuntimeRpcClientTestBridge,
  runtimeCall,
  runtimeEnvironmentCall,
  runtimeEnvironmentSubscribe
} from './runtime-rpc-client-test-bridge'

installRuntimeRpcClientTestBridge()

describe('runtime RPC client routing', () => {
  it('routes local runtime calls through window.api.runtime.call', async () => {
    runtimeCall.mockResolvedValue({
      id: 'local',
      ok: true,
      result: [{ id: 'repo-1' }],
      _meta: { runtimeId: 'local-runtime' }
    })

    await expect(callRuntimeRpc({ kind: 'local' }, 'repo.list')).resolves.toEqual([
      { id: 'repo-1' }
    ])
    expect(runtimeCall).toHaveBeenCalledWith({ method: 'repo.list', params: undefined })
    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
  })

  it('marks local UI-owned runtime calls so feature interaction tracking can ignore them', async () => {
    runtimeCall.mockResolvedValue({
      id: 'local',
      ok: true,
      result: { ok: true },
      _meta: { runtimeId: 'local-runtime' }
    })

    await callRuntimeRpc(
      { kind: 'local' },
      'browser.viewport',
      { page: 'page-1' },
      { suppressFeatureInteraction: true }
    )

    expect(runtimeCall).toHaveBeenCalledWith({
      method: 'browser.viewport',
      params: {
        page: 'page-1',
        [ORCA_RUNTIME_RPC_FEATURE_INTERACTION_SOURCE_KEY]: ORCA_RUNTIME_RPC_BROWSER_UI_SOURCE
      }
    })
    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
  })

  it('routes remote runtime calls through window.api.runtimeEnvironments.call', async () => {
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'remote',
      ok: true,
      result: { graphStatus: 'ready' },
      _meta: { runtimeId: 'remote-runtime' }
    })

    await expect(
      callRuntimeRpc({ kind: 'environment', environmentId: 'env-1' }, 'status.get', undefined, {
        timeoutMs: 50
      })
    ).resolves.toEqual({ graphStatus: 'ready' })
    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'status.get',
      params: undefined,
      timeoutMs: 50
    })
    expect(runtimeCall).not.toHaveBeenCalled()
  })

  it('uses an abortable subscription for paired-runtime requests', async () => {
    const controller = new AbortController()
    const unsubscribe = vi.fn()
    runtimeEnvironmentSubscribe.mockResolvedValue({ unsubscribe, sendBinary: vi.fn() })

    const request = callRuntimeRpc(
      { kind: 'environment', environmentId: 'env-1' },
      'status.get',
      undefined,
      { signal: controller.signal }
    )
    await vi.waitFor(() => expect(runtimeEnvironmentSubscribe).toHaveBeenCalled())
    controller.abort()

    await expect(request).rejects.toMatchObject({ name: 'AbortError' })
    await vi.waitFor(() => expect(unsubscribe).toHaveBeenCalledTimes(1))
    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
  })

  it.each([false, true])(
    'never sends a paired-runtime request whose pre-send guard throws (abortable=%s)',
    async (abortable) => {
      const onSent = vi.fn()
      const request = callRuntimeRpc(
        { kind: 'environment', environmentId: 'env-1' },
        'status.get',
        undefined,
        {
          ...(abortable ? { signal: new AbortController().signal } : {}),
          beforeSend: () => {
            throw new Error('superseded')
          },
          onSent
        }
      )

      await expect(request).rejects.toThrow('superseded')
      expect(runtimeEnvironmentSubscribe).not.toHaveBeenCalled()
      expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
      expect(onSent).not.toHaveBeenCalled()
    }
  )

  it("reports the paired host's send time separately from the pre-send guard", async () => {
    const order: string[] = []
    runtimeEnvironmentSubscribe.mockImplementation(
      async (_args: unknown, callbacks: { onSent: (sentAt?: number) => void }) => {
        order.push('dispatch')
        callbacks.onSent(1234)
        return { unsubscribe: vi.fn(), sendBinary: vi.fn() }
      }
    )
    const controller = new AbortController()
    const request = callRuntimeRpc(
      { kind: 'environment', environmentId: 'env-1' },
      'status.get',
      undefined,
      {
        signal: controller.signal,
        beforeSend: () => order.push('guard'),
        onSent: (sentAt) => order.push(`sent ${sentAt}`)
      }
    )
    await vi.waitFor(() => expect(order).toEqual(['guard', 'dispatch', 'sent 1234']))
    controller.abort()
    await expect(request).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('rejects an abortable paired-runtime request at the response deadline', async () => {
    vi.useFakeTimers()
    try {
      const controller = new AbortController()
      const unsubscribe = vi.fn()
      runtimeEnvironmentSubscribe.mockResolvedValue({ unsubscribe, sendBinary: vi.fn() })

      const request = callRuntimeRpc(
        { kind: 'environment', environmentId: 'env-1' },
        'status.get',
        undefined,
        { signal: controller.signal, timeoutMs: 15_000 }
      )
      await vi.waitFor(() => expect(runtimeEnvironmentSubscribe).toHaveBeenCalled())
      const rejection = expect(request).rejects.toThrow('timed out before status.get completed')
      await vi.advanceTimersByTimeAsync(15_000)

      await rejection
      await vi.waitFor(() => expect(unsubscribe).toHaveBeenCalledTimes(1))
    } finally {
      vi.useRealTimers()
    }
  })

  it('preflights remote runtime compatibility before non-status calls', async () => {
    runtimeEnvironmentCall.mockImplementation(({ method }: { method: string }) => {
      const result =
        method === 'status.get'
          ? {
              runtimeId: 'remote-runtime',
              graphStatus: 'ready',
              runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
              minCompatibleRuntimeClientVersion: MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION
            }
          : { repos: [{ id: 'repo-1' }] }
      return Promise.resolve({
        id: method,
        ok: true,
        result,
        _meta: { runtimeId: 'remote-runtime' }
      })
    })

    await expect(
      callRuntimeRpc({ kind: 'environment', environmentId: 'env-compat' }, 'repo.list')
    ).resolves.toEqual({ repos: [{ id: 'repo-1' }] })

    expect(runtimeEnvironmentCall.mock.calls.map((call) => call[0].method)).toEqual([
      'status.get',
      'repo.list'
    ])
  })

  it('reuses recent remote compatibility failures during startup catalog bursts', async () => {
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'status',
      ok: false,
      error: { code: 'runtime_unavailable', message: 'offline' },
      _meta: { runtimeId: 'remote-runtime' }
    })
    const target = { kind: 'environment', environmentId: 'env-offline' } as const

    await expect(
      callRuntimeRpc(target, 'repo.list', undefined, { reuseRecentCompatibilityFailure: true })
    ).rejects.toThrow('offline')
    await expect(
      callRuntimeRpc(target, 'projectGroup.list', undefined, {
        reuseRecentCompatibilityFailure: true
      })
    ).rejects.toThrow('offline')
    await expect(
      callRuntimeRpc(target, 'folderWorkspace.list', undefined, {
        reuseRecentCompatibilityFailure: true
      })
    ).rejects.toThrow('offline')

    expect(runtimeEnvironmentCall.mock.calls.map((call) => call[0].method)).toEqual(['status.get'])
  })

  it('expires startup compatibility failures at the TTL boundary', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(0))
    try {
      let statusCalls = 0
      runtimeEnvironmentCall.mockImplementation(({ method }: { method: string }) => {
        if (method === 'status.get') {
          statusCalls += 1
          if (statusCalls === 1) {
            return Promise.resolve({
              id: 'status',
              ok: false,
              error: { code: 'runtime_unavailable', message: 'offline' },
              _meta: { runtimeId: 'remote-runtime' }
            })
          }
          return Promise.resolve({
            id: 'status',
            ok: true,
            result: {
              runtimeId: 'remote-runtime',
              graphStatus: 'ready',
              runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
              minCompatibleRuntimeClientVersion: MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION
            },
            _meta: { runtimeId: 'remote-runtime' }
          })
        }
        return Promise.resolve({
          id: method,
          ok: true,
          result: { ok: true },
          _meta: { runtimeId: 'remote-runtime' }
        })
      })
      const target = { kind: 'environment', environmentId: 'env-ttl' } as const

      await expect(
        callRuntimeRpc(target, 'repo.list', undefined, { reuseRecentCompatibilityFailure: true })
      ).rejects.toThrow('offline')
      vi.setSystemTime(new Date(60_000))
      await expect(
        callRuntimeRpc(target, 'repo.list', undefined, { reuseRecentCompatibilityFailure: true })
      ).resolves.toEqual({ ok: true })

      expect(runtimeEnvironmentCall.mock.calls.map((call) => call[0].method)).toEqual([
        'status.get',
        'status.get',
        'repo.list'
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it('retries normal remote calls after a catalog-burst compatibility failure', async () => {
    let statusCalls = 0
    runtimeEnvironmentCall.mockImplementation(({ method }: { method: string }) => {
      if (method === 'status.get') {
        statusCalls += 1
        if (statusCalls === 1) {
          return Promise.resolve({
            id: 'status',
            ok: false,
            error: { code: 'runtime_unavailable', message: 'offline' },
            _meta: { runtimeId: 'remote-runtime' }
          })
        }
        return Promise.resolve({
          id: 'status',
          ok: true,
          result: {
            runtimeId: 'remote-runtime',
            graphStatus: 'ready',
            runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
            minCompatibleRuntimeClientVersion: MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION
          },
          _meta: { runtimeId: 'remote-runtime' }
        })
      }
      return Promise.resolve({
        id: method,
        ok: true,
        result: { ok: true },
        _meta: { runtimeId: 'remote-runtime' }
      })
    })
    const target = { kind: 'environment', environmentId: 'env-recovers' } as const

    await expect(
      callRuntimeRpc(target, 'repo.list', undefined, { reuseRecentCompatibilityFailure: true })
    ).rejects.toThrow('offline')
    await expect(callRuntimeRpc(target, 'git.status')).resolves.toEqual({ ok: true })

    expect(runtimeEnvironmentCall.mock.calls.map((call) => call[0].method)).toEqual([
      'status.get',
      'status.get',
      'git.status'
    ])
  })

  it('lets background compatibility checks reuse a recent foreground failure', async () => {
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'status',
      ok: false,
      error: { code: 'runtime_unavailable', message: 'offline' },
      _meta: { runtimeId: 'remote-runtime' }
    })
    const target = { kind: 'environment', environmentId: 'env-offline' } as const

    await expect(callRuntimeRpc(target, 'git.status')).rejects.toThrow('offline')
    await expect(
      callRuntimeRpc(target, 'repo.list', undefined, {
        reuseRecentCompatibilityFailure: true
      })
    ).rejects.toThrow('offline')

    expect(runtimeEnvironmentCall.mock.calls.map((call) => call[0].method)).toEqual(['status.get'])
  })

  it('re-probes after a status success clears a recent compatibility failure', async () => {
    let statusCalls = 0
    runtimeEnvironmentCall.mockImplementation(({ method }: { method: string }) => {
      if (method === 'status.get') {
        statusCalls += 1
        if (statusCalls === 1) {
          return Promise.resolve({
            id: 'status',
            ok: false,
            error: { code: 'runtime_unavailable', message: 'offline' },
            _meta: { runtimeId: 'remote-runtime' }
          })
        }
        return Promise.resolve({
          id: 'status',
          ok: true,
          result: {
            runtimeId: 'remote-runtime',
            graphStatus: 'ready',
            runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
            minCompatibleRuntimeClientVersion: MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION
          },
          _meta: { runtimeId: 'remote-runtime' }
        })
      }
      return Promise.resolve({
        id: method,
        ok: true,
        result: { ok: true },
        _meta: { runtimeId: 'remote-runtime' }
      })
    })
    const target = { kind: 'environment', environmentId: 'env-back-online' } as const

    await expect(
      callRuntimeRpc(target, 'repo.list', undefined, { reuseRecentCompatibilityFailure: true })
    ).rejects.toThrow('offline')
    clearRecentRuntimeCompatibilityFailure('env-back-online')
    await expect(
      callRuntimeRpc(target, 'worktree.detectedList', undefined, {
        reuseRecentCompatibilityFailure: true
      })
    ).resolves.toEqual({ ok: true })

    expect(runtimeEnvironmentCall.mock.calls.map((call) => call[0].method)).toEqual([
      'status.get',
      'status.get',
      'worktree.detectedList'
    ])
  })

  it('keeps a proven-compatible cache entry when clearing recent failures', async () => {
    runtimeEnvironmentCall.mockImplementation(({ method }: { method: string }) => {
      if (method === 'status.get') {
        return Promise.resolve({
          id: 'status',
          ok: true,
          result: {
            runtimeId: 'remote-runtime',
            graphStatus: 'ready',
            runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
            minCompatibleRuntimeClientVersion: MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION
          },
          _meta: { runtimeId: 'remote-runtime' }
        })
      }
      return Promise.resolve({
        id: method,
        ok: true,
        result: { ok: true },
        _meta: { runtimeId: 'remote-runtime' }
      })
    })
    const target = { kind: 'environment', environmentId: 'env-still-ok' } as const

    await expect(callRuntimeRpc(target, 'repo.list')).resolves.toEqual({ ok: true })
    clearRecentRuntimeCompatibilityFailure('env-still-ok')
    await expect(callRuntimeRpc(target, 'git.status')).resolves.toEqual({ ok: true })

    expect(runtimeEnvironmentCall.mock.calls.map((call) => call[0].method)).toEqual([
      'status.get',
      'repo.list',
      'git.status'
    ])
  })

  it('re-probes when a status success clears a still-pending compatibility probe', async () => {
    // Reachable status can overtake an offline probe still queued on the dead connection. Clear that pending probe so reuse calls start fresh without inheriting its late rejection.
    let rejectFirstStatus!: (error: Error) => void
    let statusCalls = 0
    runtimeEnvironmentCall.mockImplementation(({ method }: { method: string }) => {
      if (method === 'status.get') {
        statusCalls += 1
        if (statusCalls === 1) {
          return new Promise((_, reject) => {
            rejectFirstStatus = reject
          })
        }
        return Promise.resolve({
          id: 'status',
          ok: true,
          result: {
            runtimeId: 'remote-runtime',
            graphStatus: 'ready',
            runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
            minCompatibleRuntimeClientVersion: MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION
          },
          _meta: { runtimeId: 'remote-runtime' }
        })
      }
      return Promise.resolve({
        id: method,
        ok: true,
        result: { ok: true },
        _meta: { runtimeId: 'remote-runtime' }
      })
    })
    const target = { kind: 'environment', environmentId: 'env-reconnect' } as const

    const pendingResult = callRuntimeRpc(target, 'repo.list', undefined, {
      reuseRecentCompatibilityFailure: true
    }).then(
      () => 'resolved',
      (error) => `rejected:${error.message}`
    )
    // Let the first status.get register its in-flight cache entry.
    await Promise.resolve()

    clearRecentRuntimeCompatibilityFailure('env-reconnect')

    const secondCall = callRuntimeRpc(target, 'worktree.detectedList', undefined, {
      reuseRecentCompatibilityFailure: true
    })
    await Promise.resolve()
    // The doomed pending probe rejects; it must not fail the fresh re-probe.
    rejectFirstStatus(new Error('stale connection closed'))

    await expect(secondCall).resolves.toEqual({ ok: true })
    await expect(pendingResult).resolves.toBe('rejected:stale connection closed')

    expect(runtimeEnvironmentCall.mock.calls.map((call) => call[0].method)).toEqual([
      'status.get',
      'status.get',
      'worktree.detectedList'
    ])
  })

  it('marks remote UI-owned runtime calls so feature interaction tracking can ignore them', async () => {
    runtimeEnvironmentCall.mockImplementation(({ method }: { method: string }) => {
      const result =
        method === 'status.get'
          ? {
              runtimeId: 'remote-runtime',
              graphStatus: 'ready',
              runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
              minCompatibleRuntimeClientVersion: MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION
            }
          : { ok: true }
      return Promise.resolve({
        id: method,
        ok: true,
        result,
        _meta: { runtimeId: 'remote-runtime' }
      })
    })

    await callRuntimeRpc(
      { kind: 'environment', environmentId: 'env-1' },
      'browser.viewport',
      { page: 'page-1' },
      { suppressFeatureInteraction: true }
    )

    expect(runtimeEnvironmentCall).toHaveBeenLastCalledWith({
      selector: 'env-1',
      method: 'browser.viewport',
      params: {
        page: 'page-1',
        [ORCA_RUNTIME_RPC_FEATURE_INTERACTION_SOURCE_KEY]: ORCA_RUNTIME_RPC_BROWSER_UI_SOURCE
      },
      timeoutMs: undefined
    })
  })

  it('caches successful remote compatibility checks per environment', async () => {
    runtimeEnvironmentCall.mockImplementation(({ method }: { method: string }) => {
      const result =
        method === 'status.get'
          ? {
              runtimeId: 'remote-runtime',
              graphStatus: 'ready',
              runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
              minCompatibleRuntimeClientVersion: MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION
            }
          : { ok: true }
      return Promise.resolve({
        id: method,
        ok: true,
        result,
        _meta: { runtimeId: 'remote-runtime' }
      })
    })

    await callRuntimeRpc({ kind: 'environment', environmentId: 'env-cache' }, 'repo.list')
    await callRuntimeRpc({ kind: 'environment', environmentId: 'env-cache' }, 'worktree.list')

    expect(runtimeEnvironmentCall.mock.calls.map((call) => call[0].method)).toEqual([
      'status.get',
      'repo.list',
      'worktree.list'
    ])
  })

  it('bounds successful remote compatibility checks by evicting old environments', async () => {
    runtimeEnvironmentCall.mockImplementation(({ method }: { method: string }) => {
      const result =
        method === 'status.get'
          ? {
              runtimeId: 'remote-runtime',
              graphStatus: 'ready',
              runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
              minCompatibleRuntimeClientVersion: MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION
            }
          : { ok: true }
      return Promise.resolve({
        id: method,
        ok: true,
        result,
        _meta: { runtimeId: 'remote-runtime' }
      })
    })

    for (let i = 0; i < 33; i += 1) {
      await callRuntimeRpc({ kind: 'environment', environmentId: `env-${i}` }, 'repo.list')
    }

    runtimeEnvironmentCall.mockClear()
    await callRuntimeRpc({ kind: 'environment', environmentId: 'env-0' }, 'worktree.list')
    expect(runtimeEnvironmentCall.mock.calls.map((call) => call[0].method)).toEqual([
      'status.get',
      'worktree.list'
    ])

    runtimeEnvironmentCall.mockClear()
    await callRuntimeRpc({ kind: 'environment', environmentId: 'env-32' }, 'worktree.list')
    expect(runtimeEnvironmentCall.mock.calls.map((call) => call[0].method)).toEqual([
      'worktree.list'
    ])
  })

  it('throws structured runtime RPC failures', () => {
    const failure = {
      id: 'rpc-1',
      ok: false as const,
      error: { code: 'method_not_found', message: 'Unknown method: nope' },
      _meta: { runtimeId: 'runtime-1' }
    }

    expect(() => unwrapRuntimeRpcResult(failure)).toThrow(RuntimeRpcCallError)
    try {
      unwrapRuntimeRpcResult(failure)
    } catch (error) {
      expect(error).toBeInstanceOf(RuntimeRpcCallError)
      expect((error as RuntimeRpcCallError).code).toBe('method_not_found')
      expect((error as RuntimeRpcCallError).response).toBe(failure)
    }
  })
})
