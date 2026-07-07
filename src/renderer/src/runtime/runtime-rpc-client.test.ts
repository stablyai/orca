import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  callRuntimeRpc,
  assertRuntimeEnvironmentCapability,
  clearRuntimeCompatibilityCacheForTests,
  getActiveRuntimeTarget,
  RuntimeRpcCallError,
  unwrapRuntimeRpcResult
} from './runtime-rpc-client'
import {
  MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
  RUNTIME_PROTOCOL_VERSION
} from '../../../shared/protocol-version'
import {
  ORCA_RUNTIME_RPC_BROWSER_UI_SOURCE,
  ORCA_RUNTIME_RPC_FEATURE_INTERACTION_SOURCE_KEY
} from '../../../shared/runtime-rpc-feature-interaction-source'

const runtimeCall = vi.fn()
const runtimeEnvironmentCall = vi.fn()

beforeEach(() => {
  clearRuntimeCompatibilityCacheForTests()
  runtimeCall.mockReset()
  runtimeEnvironmentCall.mockReset()
  vi.stubGlobal('window', {
    api: {
      runtime: { call: runtimeCall },
      runtimeEnvironments: { call: runtimeEnvironmentCall }
    }
  })
})

describe('runtime RPC client routing', () => {
  it('uses the local runtime when no active environment is selected', () => {
    expect(getActiveRuntimeTarget(null)).toEqual({ kind: 'local' })
    expect(getActiveRuntimeTarget({ activeRuntimeEnvironmentId: null })).toEqual({ kind: 'local' })
    expect(getActiveRuntimeTarget({ activeRuntimeEnvironmentId: '   ' })).toEqual({ kind: 'local' })
  })

  it('uses the active saved environment when one is selected', () => {
    expect(getActiveRuntimeTarget({ activeRuntimeEnvironmentId: 'env-1' })).toEqual({
      kind: 'environment',
      environmentId: 'env-1'
    })
  })

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

  it('checks advertised runtime capabilities after protocol compatibility', async () => {
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'status',
      ok: true,
      result: {
        runtimeId: 'remote-runtime',
        graphStatus: 'ready',
        runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
        minCompatibleRuntimeClientVersion: MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
        capabilities: ['project-host-setup.v1']
      },
      _meta: { runtimeId: 'remote-runtime' }
    })

    await expect(
      assertRuntimeEnvironmentCapability(
        'env-1',
        'project-host-setup.v1',
        'Project setup is unavailable.'
      )
    ).resolves.toBeUndefined()
  })

  it('rejects missing advertised runtime capabilities with the caller message', async () => {
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'status',
      ok: true,
      result: {
        runtimeId: 'remote-runtime',
        graphStatus: 'ready',
        runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
        minCompatibleRuntimeClientVersion: MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
        capabilities: []
      },
      _meta: { runtimeId: 'remote-runtime' }
    })

    await expect(
      assertRuntimeEnvironmentCapability(
        'env-1',
        'project-host-setup.v1',
        'Project setup is unavailable.'
      )
    ).rejects.toThrow('Project setup is unavailable.')
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
