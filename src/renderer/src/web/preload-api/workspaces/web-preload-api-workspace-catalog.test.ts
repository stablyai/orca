import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeRpcResponse } from '../../../../../shared/remote-runtime/rpc/runtime-rpc-envelope'
import {
  encodePairingCode,
  installBrowserGlobals,
  writeStoredRuntimeEnvironment
} from '../../testing/web-preload-api-test-harness'

describe('web repos preload API', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.doUnmock('../../runtime/client/web-runtime-client')
  })

  it('does not reassign an in-flight catalog when the browser pairs to another server', async () => {
    let resolveCatalog!: (response: RuntimeRpcResponse<unknown>) => void
    const pendingCatalog = new Promise<RuntimeRpcResponse<unknown>>((resolve) => {
      resolveCatalog = resolve
    })
    vi.doMock('../../runtime/client/web-runtime-client', () => ({
      WebRuntimeClient: class {
        call(): Promise<RuntimeRpcResponse<unknown>> {
          return pendingCatalog
        }

        close(): void {}
      }
    }))

    const globals = installBrowserGlobals('Linux')
    writeStoredRuntimeEnvironment(globals.storage, 'web-server-a')
    const { installWebPreloadApi } = await import('../../web-preload-api')
    installWebPreloadApi()
    const catalogPromise = globals.window.api.repos.list()
    const pairingCode = encodePairingCode({
      endpoint: 'wss://server-b.example:443',
      deviceToken: 'server-b-token',
      publicKeyB64: 'server-b-key'
    })
    await globals.window.api.runtimeEnvironments.addFromPairingCode({
      name: 'Server B',
      pairingCode
    })

    resolveCatalog({
      id: 'repo-list',
      ok: true,
      result: {
        repos: [
          {
            id: 'repo-a',
            path: '/srv/a',
            displayName: 'A',
            badgeColor: '#000',
            addedAt: 1,
            executionHostId: 'local'
          }
        ]
      },
      _meta: { runtimeId: 'runtime-a' }
    })

    await expect(catalogPromise).resolves.toMatchObject([
      { id: 'repo-a', executionHostId: 'runtime:web-server-a' }
    ])
    await expect(globals.window.api.runtimeEnvironments.list()).resolves.toMatchObject([
      { name: 'Server B' }
    ])
  })
})
