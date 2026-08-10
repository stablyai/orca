import { beforeEach, describe, expect, it, vi } from 'vitest'
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

describe('runtime RPC timeout routing', () => {
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
      params: {},
      timeoutMs: 125_000,
      expectedEnvironmentPairingRevision: undefined
    })
  })
})
