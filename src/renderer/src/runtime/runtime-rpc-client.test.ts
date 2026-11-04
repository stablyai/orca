import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  callRuntimeRpc,
  clearRecentRuntimeCompatibilityFailure,
  clearRuntimeCompatibilityCacheForTests,
  runtimeEnvironmentSupportsCapability
} from './runtime-rpc-client'
import './runtime-rpc-result'
import {
  MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
  RUNTIME_PROTOCOL_VERSION
} from '../../../shared/protocol-version'
import '../../../shared/runtime-rpc-feature-interaction-source'

const runtimeCall = vi.fn()
const runtimeEnvironmentCall = vi.fn()
const runtimeEnvironmentSubscribe = vi.fn()

beforeEach(() => {
  clearRuntimeCompatibilityCacheForTests()
  runtimeCall.mockReset()
  runtimeEnvironmentCall.mockReset()
  runtimeEnvironmentSubscribe.mockReset()
  vi.stubGlobal('window', {
    api: {
      runtime: { call: runtimeCall },
      runtimeEnvironments: {
        call: runtimeEnvironmentCall,
        subscribe: runtimeEnvironmentSubscribe
      }
    }
  })
})

describe('runtime RPC client routing', () => {
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

  it('coalesces concurrent cold-cache capability probes onto one status.get', async () => {
    let statusCalls = 0
    runtimeEnvironmentCall.mockImplementation(() => {
      statusCalls += 1
      return Promise.resolve({
        id: 'status',
        ok: true,
        result: {
          runtimeId: 'remote-runtime',
          graphStatus: 'ready',
          runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
          minCompatibleRuntimeClientVersion: MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
          capabilities: ['linear.issue-attribute-filter.v1']
        },
        _meta: { runtimeId: 'remote-runtime' }
      })
    })

    const [a, b, c] = await Promise.all([
      runtimeEnvironmentSupportsCapability(
        'env-cap-concurrent',
        'linear.issue-attribute-filter.v1'
      ),
      runtimeEnvironmentSupportsCapability(
        'env-cap-concurrent',
        'linear.issue-attribute-filter.v1'
      ),
      runtimeEnvironmentSupportsCapability('env-cap-concurrent', 'linear.issue-attribute-filter.v1')
    ])

    expect([a, b, c]).toEqual([true, true, true])
    expect(statusCalls).toBe(1)
  })

  it('expires a supported capability verdict so a runtime downgrade is detected', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(0))
    try {
      let statusCalls = 0
      runtimeEnvironmentCall.mockImplementation(() => {
        statusCalls += 1
        return Promise.resolve({
          id: 'status',
          ok: true,
          result: {
            runtimeId: 'remote-runtime',
            graphStatus: 'ready',
            runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
            minCompatibleRuntimeClientVersion: MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
            capabilities: statusCalls === 1 ? ['linear.issue-attribute-filter.v1'] : []
          },
          _meta: { runtimeId: 'remote-runtime' }
        })
      })

      await expect(
        runtimeEnvironmentSupportsCapability(
          'env-cap-downgrade',
          'linear.issue-attribute-filter.v1'
        )
      ).resolves.toBe(true)
      vi.setSystemTime(new Date(59_999))
      await expect(
        runtimeEnvironmentSupportsCapability(
          'env-cap-downgrade',
          'linear.issue-attribute-filter.v1'
        )
      ).resolves.toBe(true)
      vi.setSystemTime(new Date(60_000))
      await expect(
        runtimeEnvironmentSupportsCapability(
          'env-cap-downgrade',
          'linear.issue-attribute-filter.v1'
        )
      ).resolves.toBe(false)
      expect(statusCalls).toBe(2)
    } finally {
      vi.useRealTimers()
    }
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
})
