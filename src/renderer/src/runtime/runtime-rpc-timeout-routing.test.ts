import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
  RUNTIME_PROTOCOL_VERSION
} from '../../../shared/protocol-version'
import { callRuntimeRpc, clearRuntimeCompatibilityCacheForTests } from './runtime-rpc-client'

const runtimeEnvironmentCall = vi.fn()

beforeEach(() => {
  clearRuntimeCompatibilityCacheForTests()
  runtimeEnvironmentCall.mockReset()
  vi.stubGlobal('window', {
    api: {
      runtimeEnvironments: {
        call: runtimeEnvironmentCall
      }
    }
  })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('runtime RPC timeout routing', () => {
  it('uses one absolute deadline across compatibility and operation transport', async () => {
    vi.useFakeTimers()
    runtimeEnvironmentCall.mockImplementation(
      ({ method }: { method: string }) =>
        new Promise((resolve) => {
          setTimeout(
            () =>
              resolve({
                id: method,
                ok: true,
                result:
                  method === 'status.get'
                    ? {
                        runtimeId: 'remote-runtime',
                        graphStatus: 'ready',
                        runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
                        minCompatibleRuntimeClientVersion: MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION
                      }
                    : { ok: true },
                _meta: { runtimeId: 'remote-runtime' }
              }),
            method === 'status.get' ? 60 : 50
          )
        })
    )
    let settled = false

    void callRuntimeRpc(
      { kind: 'environment', environmentId: 'env-one-deadline' },
      'git.push',
      {},
      { timeoutMs: 100, compatibilityTimeoutMs: 100 }
    )
      .catch(() => {})
      .finally(() => {
        settled = true
      })

    await vi.advanceTimersByTimeAsync(100)

    expect(settled).toBe(true)
  })

  it('applies the host-configured action deadline from compatibility status', async () => {
    vi.useFakeTimers()
    runtimeEnvironmentCall.mockImplementation(({ method }: { method: string }) => {
      if (method !== 'status.get') {
        return new Promise(() => {})
      }
      return new Promise((resolve) => {
        setTimeout(
          () =>
            resolve({
              id: method,
              ok: true,
              result: {
                runtimeId: 'remote-runtime',
                graphStatus: 'ready',
                runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
                minCompatibleRuntimeClientVersion: MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
                gitRemoteOperationTimeoutMs: 100
              },
              _meta: { runtimeId: 'remote-runtime' }
            }),
          60
        )
      })
    })
    let settled = false

    void callRuntimeRpc(
      { kind: 'environment', environmentId: 'env-configured-deadline' },
      'git.push',
      {},
      { timeoutMs: 1_000, compatibilityTimeoutMs: 1_000 }
    )
      .catch(() => {})
      .finally(() => {
        settled = true
      })

    await vi.advanceTimersByTimeAsync(100)

    expect(settled).toBe(true)
    expect(runtimeEnvironmentCall).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        method: 'git.push',
        params: { operationTimeoutMs: 40 },
        timeoutMs: 40
      })
    )
  })

  it('keeps compatibility probes shorter than long-running operation requests', async () => {
    runtimeEnvironmentCall.mockImplementation(({ method }: { method: string }) =>
      Promise.resolve({
        id: method,
        ok: true,
        result:
          method === 'status.get'
            ? {
                runtimeId: 'remote-runtime',
                graphStatus: 'ready',
                runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
                minCompatibleRuntimeClientVersion: MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION
              }
            : { ok: true },
        _meta: { runtimeId: 'remote-runtime' }
      })
    )

    await callRuntimeRpc(
      { kind: 'environment', environmentId: 'env-long-operation' },
      'git.push',
      {},
      { timeoutMs: 125_000, compatibilityTimeoutMs: 15_000 }
    )

    expect(runtimeEnvironmentCall).toHaveBeenNthCalledWith(1, {
      selector: 'env-long-operation',
      method: 'status.get',
      timeoutMs: 15_000,
      expectedEnvironmentPairingRevision: undefined
    })
    expect(runtimeEnvironmentCall).toHaveBeenNthCalledWith(2, {
      selector: 'env-long-operation',
      method: 'git.push',
      params: { operationTimeoutMs: 125_000 },
      timeoutMs: 125_000,
      expectedEnvironmentPairingRevision: undefined
    })
  })
})
