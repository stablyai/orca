import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import {
  installBrowserGlobals,
  writeStoredRuntimeEnvironment
} from './web-preload-api-test-harness'

describe('web Jira preload API', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.doUnmock('./web-runtime-client')
  })

  it('routes Jira connector calls through the paired runtime', async () => {
    const runtimeCalls: { method: string; params: unknown }[] = []
    vi.doMock('./web-runtime-client', () => ({
      WebRuntimeClient: class {
        call(method: string, params?: unknown): Promise<RuntimeRpcResponse<unknown>> {
          runtimeCalls.push({ method, params })
          return Promise.resolve({
            id: `call-${runtimeCalls.length}`,
            ok: true,
            result:
              method === 'jira.connect'
                ? { ok: true, viewer: { accountId: 'viewer-1', displayName: 'Test User' } }
                : { connected: false, viewer: null },
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

    const credentials = {
      siteUrl: 'https://jira.example.com',
      email: 'user@example.com',
      apiToken: 'token'
    }
    await expect(globals.window.api.jira.connect(credentials)).resolves.toMatchObject({ ok: true })
    await expect(globals.window.api.jira.status()).resolves.toEqual({
      connected: false,
      viewer: null
    })

    expect(runtimeCalls).toEqual([
      { method: 'jira.connect', params: credentials },
      { method: 'jira.status', params: undefined }
    ])
  })
})
