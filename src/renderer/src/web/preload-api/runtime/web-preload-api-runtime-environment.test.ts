import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeRpcResponse } from '../../../../../shared/remote-runtime/rpc/runtime-rpc-envelope'
import { MIN_COMPATIBLE_RUNTIME_SERVER_VERSION } from '../../../../../shared/remote-runtime/protocol/protocol-version'
import {
  encodePairingCode,
  installBrowserGlobals,
  writeStoredRuntimeEnvironment
} from '../../testing/web-preload-api-test-harness'

describe('web runtime environment identity', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.doUnmock('../../runtime/client/web-runtime-client')
  })

  it('keeps the current host when verification rejects an incompatible replacement', async () => {
    vi.doMock('../../runtime/client/web-runtime-client', () => ({
      WebRuntimeClient: class {
        call(): Promise<RuntimeRpcResponse<unknown>> {
          return Promise.resolve({
            id: 'status',
            ok: true,
            result: { runtimeProtocolVersion: MIN_COMPATIBLE_RUNTIME_SERVER_VERSION - 1 },
            _meta: { runtimeId: 'runtime-old' }
          })
        }

        close(): void {}
      }
    }))
    const globals = installBrowserGlobals('Linux')
    writeStoredRuntimeEnvironment(globals.storage, 'web-server-a')
    const previousStored = globals.storage.getItem('orca.web.runtimeEnvironment.v1')
    const { installWebPreloadApi } = await import('../../web-preload-api')
    installWebPreloadApi()

    await expect(
      globals.window.api.runtimeEnvironments.verifyAndAddFromPairingCode({
        name: 'Incompatible server',
        pairingCode: encodePairingCode()
      })
    ).resolves.toMatchObject({ ok: false, kind: 'protocol-incompatible' })
    expect(globals.storage.getItem('orca.web.runtimeEnvironment.v1')).toBe(previousStored)
    await expect(globals.window.api.runtimeEnvironments.list()).resolves.toMatchObject([
      { id: 'web-server-a' }
    ])
  })
})
