import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import {
  installBrowserGlobals,
  writeStoredRuntimeEnvironment
} from './web-preload-api-test-harness'

describe('web GLM host site', () => {
  beforeEach(() => vi.resetModules())
  afterEach(() => vi.unstubAllGlobals())
  it('reads the host GLM site without sending site or secret changes back', async () => {
    const runtimeCalls: { method: string; params: unknown }[] = []
    vi.doMock('./web-runtime-client', () => ({
      WebRuntimeClient: class {
        call(method: string, params?: unknown): Promise<RuntimeRpcResponse<unknown>> {
          runtimeCalls.push({ method, params })
          return Promise.resolve({
            id: 'site-read',
            ok: true,
            result: { settings: { zcodePlanSite: 'bigmodel' } },
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
    expect((await globals.window.api.settings.get()).zcodePlanSite).toBe('bigmodel')
    expect((await globals.window.api.settings.set({ zcodePlanSite: 'zai' })).zcodePlanSite).toBe(
      'bigmodel'
    )
    await expect(
      globals.window.api.zcodePlanCredentials.saveApiKey('synthetic-key')
    ).rejects.toThrow()
    expect(runtimeCalls).toEqual([{ method: 'settings.get', params: undefined }])
  })
})

describe('old host GLM settings', () => {
  beforeEach(() => vi.resetModules())
  afterEach(() => vi.unstubAllGlobals())

  it.each([undefined, 'bigmodel', 'zai'])(
    'does not promote browser site %s to omitted host site',
    async (cachedSite) => {
      vi.doMock('./web-runtime-client', () => ({
        WebRuntimeClient: class {
          call(): Promise<RuntimeRpcResponse<unknown>> {
            return Promise.resolve({
              id: 'old-host',
              ok: true,
              result: { settings: {} },
              _meta: { runtimeId: 'runtime-1' }
            })
          }
          close(): void {}
        }
      }))
      const globals = installBrowserGlobals('Linux')
      globals.storage.setItem('orca.web.settings.v1', JSON.stringify({ zcodePlanSite: cachedSite }))
      writeStoredRuntimeEnvironment(globals.storage)
      const { installWebPreloadApi } = await import('./web-preload-api')
      installWebPreloadApi()
      expect((await globals.window.api.settings.get()).zcodePlanSite).toBeUndefined()
      expect(await globals.window.api.zcodePlanCredentials.getStatus()).toMatchObject({
        detailsUnavailable: true
      })
    }
  )
})

describe('GLM site host attestation lifetime', () => {
  beforeEach(() => vi.resetModules())
  afterEach(() => vi.unstubAllGlobals())
  it('drops site attestation when the same host later omits the field or is repaired', async () => {
    let site: string | undefined = 'bigmodel'
    vi.doMock('./web-runtime-client', () => ({
      WebRuntimeClient: class {
        call(): Promise<RuntimeRpcResponse<unknown>> {
          return Promise.resolve({
            id: 'site',
            ok: true,
            result: { settings: site ? { zcodePlanSite: site } : {} },
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
    expect((await globals.window.api.settings.get()).zcodePlanSite).toBe('bigmodel')
    expect((await globals.window.api.settings.set({ uiLanguage: 'en' })).zcodePlanSite).toBe(
      'bigmodel'
    )
    const { webRuntimeState } = await import('./preload-api/web-runtime-session')
    const environment = webRuntimeState.activeEnvironment
    if (!environment) {
      throw new Error('Missing synthetic paired host')
    }
    environment.pairingRevision = (environment.pairingRevision ?? environment.createdAt) + 1
    expect(globals.window.api.settings.getSync?.()?.zcodePlanSite).toBeUndefined()
    site = undefined
    expect((await globals.window.api.settings.get()).zcodePlanSite).toBeUndefined()
  })
})
