import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  callRuntimeRpc,
  clearRuntimeCompatibilityCacheForTests,
  getActiveRuntimeTarget,
  RuntimeRpcCallError,
  unwrapRuntimeRpcResult
} from './runtime-rpc-client'
import {
  MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
  RUNTIME_PROTOCOL_VERSION
} from '../../../shared/protocol-version'

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
