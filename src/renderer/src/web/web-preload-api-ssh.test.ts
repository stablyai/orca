import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import {
  installBrowserGlobals,
  writeStoredRuntimeEnvironment
} from './web-preload-api-test-harness'

describe('web SSH preload API', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.doUnmock('./web-runtime-client')
  })

  it('preserves full and partial authority states from the paired runtime', async () => {
    const runtimeCalls: { method: string; params: unknown }[] = []
    vi.doMock('./web-runtime-client', () => ({
      WebRuntimeClient: class {
        call(method: string, params?: unknown): Promise<RuntimeRpcResponse<unknown>> {
          runtimeCalls.push({ method, params })
          const state =
            method === 'ssh.connect'
              ? {
                  targetId: 'ssh-1',
                  status: 'connected',
                  error: null,
                  reconnectAttempt: 0,
                  providerEpoch: 'web-provider-epoch',
                  connectionGeneration: 23
                }
              : {
                  targetId: 'ssh-1',
                  status: 'connected',
                  error: null,
                  reconnectAttempt: 0,
                  providerEpoch: 'partial-provider-epoch'
                }
          return Promise.resolve({
            id: `call-${runtimeCalls.length}`,
            ok: true,
            result: { state },
            _meta: { runtimeId: 'runtime-1' }
          })
        }

        close(): void {}
      }
    }))

    const globals = installBrowserGlobals('Linux')
    writeStoredRuntimeEnvironment(globals.storage)
    const { installWebPreloadApi } = await import('./web-preload-api')
    installWebPreloadApi()

    await expect(globals.window.api.ssh.connect({ targetId: 'ssh-1' })).resolves.toMatchObject({
      providerEpoch: 'web-provider-epoch',
      connectionGeneration: 23
    })
    const partial = await globals.window.api.ssh.getState({ targetId: 'ssh-1' })

    expect(partial).toMatchObject({ providerEpoch: 'partial-provider-epoch' })
    expect(partial).not.toHaveProperty('connectionGeneration')
    expect(runtimeCalls).toEqual([
      { method: 'ssh.connect', params: { targetId: 'ssh-1' } },
      { method: 'ssh.getState', params: { targetId: 'ssh-1' } }
    ])
  })
})
