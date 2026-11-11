import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import { MIN_COMPATIBLE_RUNTIME_SERVER_VERSION } from '../../../shared/protocol-version'
import {
  encodePairingCode,
  installBrowserGlobals,
  writeStoredRuntimeEnvironment
} from './web-preload-api-test-harness'

describe('web runtime environment identity', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.doUnmock('./web-runtime-client')
  })

  it('refuses native service headers without storing them in the browser', async () => {
    const globals = installBrowserGlobals('Linux')
    const { installWebPreloadApi } = await import('./web-preload-api')
    installWebPreloadApi()
    const before = globals.storage.getItem('orca.web.runtimeEnvironment.v1')
    await expect(
      globals.window.api.runtimeEnvironments.verifyAndAddFromPairingCode({
        name: 'Protected server',
        pairingCode: encodePairingCode(),
        edgeAuthHeaders: [{ name: 'CF-Access-Client-Secret', value: 'synthetic-secret' }]
      })
    ).resolves.toMatchObject({ ok: false })
    expect(globals.storage.getItem('orca.web.runtimeEnvironment.v1')).toBe(before)
    expect(globals.window.api.runtimeEnvironments.saveEdgeAuth).toBeUndefined()
    expect(globals.window.api.runtimeEnvironments.getEdgeAuthStatus).toBeUndefined()
  })

  it('does not resolve an old server selector through a differently keyed server', async () => {
    const globals = installBrowserGlobals('Linux')
    writeStoredRuntimeEnvironment(globals.storage, 'web-server-a')
    const { installWebPreloadApi } = await import('./web-preload-api')
    installWebPreloadApi()

    await globals.window.api.runtimeEnvironments.addFromPairingCode({
      name: 'Server B',
      pairingCode: encodePairingCode({ publicKeyB64: 'server-b-key' })
    })

    await expect(
      globals.window.api.runtimeEnvironments.resolve({ selector: 'web-server-a' })
    ).rejects.toThrow('Unknown Orca runtime environment: web-server-a')
  })

  it('keeps old selectors only when re-pairing proves the same server key', async () => {
    const globals = installBrowserGlobals('Linux')
    writeStoredRuntimeEnvironment(globals.storage, 'web-server-a')
    const { installWebPreloadApi } = await import('./web-preload-api')
    installWebPreloadApi()

    const paired = await globals.window.api.runtimeEnvironments.addFromPairingCode({
      name: 'Server A again',
      pairingCode: encodePairingCode({ publicKeyB64: 'public-key' })
    })

    await expect(
      globals.window.api.runtimeEnvironments.resolve({ selector: 'web-server-a' })
    ).resolves.toMatchObject({ id: paired.environment.id, name: 'Server A again' })
  })

  it('keeps pairing while manual disconnect fences passive reconnects', async () => {
    const calls: string[] = []
    const close = vi.fn()
    let clientCount = 0
    vi.doMock('./web-runtime-client', () => ({
      WebRuntimeClient: class {
        constructor() {
          clientCount += 1
        }

        call(method: string): Promise<RuntimeRpcResponse<unknown>> {
          calls.push(method)
          return Promise.resolve({
            id: method,
            ok: true,
            result: { runtimeId: 'runtime-1', pairedDeviceId: 'paired-device-a' },
            _meta: { runtimeId: 'runtime-1' }
          })
        }

        close(): void {
          close()
        }
      }
    }))
    const globals = installBrowserGlobals('Linux')
    writeStoredRuntimeEnvironment(globals.storage, 'web-server-a')
    const { installWebPreloadApi } = await import('./web-preload-api')
    installWebPreloadApi()

    await expect(
      globals.window.api.runtimeEnvironments.getStatus({ selector: 'web-server-a' })
    ).resolves.toMatchObject({ ok: true })
    await globals.window.api.runtimeEnvironments.disconnect({ selector: 'web-server-a' })

    await expect(globals.window.api.runtimeEnvironments.list()).resolves.toMatchObject([
      { id: 'web-server-a' }
    ])
    await expect(
      globals.window.api.runtimeEnvironments.getStatus({ selector: 'web-server-a' })
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'runtime_manually_disconnected' }
    })
    await expect(
      globals.window.api.runtimeEnvironments.call({
        selector: 'web-server-a',
        method: 'repos.list'
      })
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'runtime_manually_disconnected' }
    })
    await expect(
      globals.window.api.runtimeEnvironments.subscribe(
        { selector: 'web-server-a', method: 'terminal.subscribe' },
        { onResponse: vi.fn() }
      )
    ).rejects.toThrow('runtime_manually_disconnected')
    expect(clientCount).toBe(1)
    expect(calls).toEqual(['status.get'])
    expect(close).toHaveBeenCalledOnce()

    await expect(
      globals.window.api.runtimeEnvironments.connect({ selector: 'web-server-a' })
    ).resolves.toMatchObject({ ok: true })
    expect(clientCount).toBe(2)
    expect(calls).toEqual(['status.get', 'status.get'])
    expect(
      JSON.parse(globals.storage.getItem('orca.web.runtimeEnvironment.v1') ?? '{}')
    ).toMatchObject({ pairedDeviceId: 'paired-device-a' })
  })

  it.each(['active runtime', 'selected environment'] as const)(
    'returns a disconnect envelope when a queued %s call disconnects',
    async (route) => {
      const pending: ((response: RuntimeRpcResponse<unknown>) => void)[] = []
      const call = vi.fn(
        (method: string) =>
          new Promise<RuntimeRpcResponse<unknown>>((resolve) => {
            pending.push((response) => resolve({ ...response, id: method }))
          })
      )
      vi.doMock('./web-runtime-client', () => ({
        WebRuntimeClient: class {
          call = call
          close(): void {}
        }
      }))
      const globals = installBrowserGlobals('Linux')
      writeStoredRuntimeEnvironment(globals.storage, 'web-server-a')
      const { installWebPreloadApi } = await import('./web-preload-api')
      installWebPreloadApi()
      const invoke = (): Promise<RuntimeRpcResponse<unknown>> =>
        route === 'active runtime'
          ? globals.window.api.runtime.call({ method: 'repos.list' })
          : globals.window.api.runtimeEnvironments.call({
              selector: 'web-server-a',
              method: 'repos.list'
            })

      const activeCalls = Array.from({ length: 8 }, invoke)
      await vi.waitFor(() => expect(call).toHaveBeenCalledTimes(8))
      const queuedCall = invoke()
      expect(call).toHaveBeenCalledTimes(8)

      await globals.window.api.runtimeEnvironments.disconnect({ selector: 'web-server-a' })
      pending[0]?.({
        id: 'repos.list',
        ok: true,
        result: {},
        _meta: { runtimeId: 'runtime-1' }
      })

      await expect(queuedCall).resolves.toMatchObject({
        ok: false,
        error: { code: 'runtime_manually_disconnected' }
      })
      expect(call).toHaveBeenCalledTimes(8)

      for (const resolve of pending.slice(1)) {
        resolve({
          id: 'repos.list',
          ok: true,
          result: {},
          _meta: { runtimeId: 'runtime-1' }
        })
      }
      await expect(Promise.all(activeCalls)).resolves.toEqual(
        Array.from({ length: 8 }, () =>
          expect.objectContaining({
            ok: false,
            error: expect.objectContaining({ code: 'runtime_manually_disconnected' })
          })
        )
      )
    }
  )
  it('keeps the current host when verification rejects an incompatible replacement', async () => {
    vi.doMock('./web-runtime-client', () => ({
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
    const { installWebPreloadApi } = await import('./web-preload-api')
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

  it('keeps the current host when browser storage rejects a verified replacement', async () => {
    vi.doMock('./web-runtime-client', () => ({
      WebRuntimeClient: class {
        call(): Promise<RuntimeRpcResponse<unknown>> {
          return Promise.resolve({
            id: 'status',
            ok: true,
            result: {
              runtimeId: 'runtime-new',
              rendererGraphEpoch: 1,
              graphStatus: 'ready',
              authoritativeWindowId: 1,
              liveTabCount: 0,
              liveLeafCount: 0,
              runtimeProtocolVersion: MIN_COMPATIBLE_RUNTIME_SERVER_VERSION
            },
            _meta: { runtimeId: 'runtime-new' }
          })
        }

        close(): void {}
      }
    }))
    const globals = installBrowserGlobals('Linux')
    writeStoredRuntimeEnvironment(globals.storage, 'web-server-a')
    const { installWebPreloadApi } = await import('./web-preload-api')
    installWebPreloadApi()
    vi.spyOn(globals.storage, 'setItem').mockImplementation(() => {
      throw new Error('Browser storage is full.')
    })

    await expect(
      globals.window.api.runtimeEnvironments.verifyAndAddFromPairingCode({
        name: 'Verified replacement',
        pairingCode: encodePairingCode()
      })
    ).resolves.toMatchObject({
      ok: false,
      kind: 'environment-save-failed',
      message: 'Orca verified the host but could not save it. Check browser storage and try again.'
    })
    await expect(globals.window.api.runtimeEnvironments.list()).resolves.toMatchObject([
      { id: 'web-server-a' }
    ])
  })

  it('requires an explicit loopback override and persists the SSH dependency', async () => {
    const call = vi.fn().mockResolvedValue({
      id: 'status',
      ok: true,
      result: {
        runtimeId: 'runtime-new',
        rendererGraphEpoch: 1,
        graphStatus: 'ready',
        authoritativeWindowId: 1,
        liveTabCount: 0,
        liveLeafCount: 0,
        runtimeProtocolVersion: MIN_COMPATIBLE_RUNTIME_SERVER_VERSION
      },
      _meta: { runtimeId: 'runtime-new' }
    })
    vi.doMock('./web-runtime-client', () => ({
      WebRuntimeClient: class {
        call = call
        close(): void {}
      }
    }))
    const globals = installBrowserGlobals('Linux')
    const { installWebPreloadApi } = await import('./web-preload-api')
    installWebPreloadApi()
    const pairingCode = encodePairingCode({ endpoint: 'ws://127.0.0.1:6768' })

    await expect(
      globals.window.api.runtimeEnvironments.verifyAndAddFromPairingCode({
        name: 'Tunnel server',
        pairingCode
      })
    ).resolves.toMatchObject({ ok: false, kind: 'host-unreachable' })
    expect(call).not.toHaveBeenCalled()

    await expect(
      globals.window.api.runtimeEnvironments.verifyAndAddFromPairingCode({
        name: 'Tunnel server',
        pairingCode,
        allowLoopback: true
      })
    ).resolves.toMatchObject({
      ok: true,
      environment: { connectionDependency: 'ssh-tunnel' }
    })
    expect(call).toHaveBeenCalledOnce()
    expect(
      JSON.parse(globals.storage.getItem('orca.web.runtimeEnvironment.v1') ?? '{}')
    ).toMatchObject({ connectionDependency: 'ssh-tunnel' })
  })
})
