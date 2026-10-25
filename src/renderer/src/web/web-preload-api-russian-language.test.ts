import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import {
  installBrowserGlobals,
  writeStoredRuntimeEnvironment
} from './web-preload-api-test-harness'

beforeEach(() => vi.resetModules())
afterEach(() => {
  vi.doUnmock('./web-runtime-client')
  vi.unstubAllGlobals()
})

describe('Russian locale on a paired web client', () => {
  it.each([false, true])(
    'persists Russian across reloads independently of an old host (offline=%s)',
    async (offline) => {
      const calls: { method: string; params: unknown }[] = []
      vi.doMock('./web-runtime-client', () => ({
        WebRuntimeClient: class {
          call(method: string, params?: unknown): Promise<RuntimeRpcResponse<unknown>> {
            calls.push({ method, params })
            return offline
              ? Promise.reject(new Error('offline'))
              : Promise.resolve({
                  id: 'old-host',
                  ok: true,
                  result: { settings: {} },
                  _meta: { runtimeId: 'old-host' }
                })
          }
          close(): void {}
        }
      }))
      const globals = installBrowserGlobals('Linux')
      writeStoredRuntimeEnvironment(globals.storage)
      const { installWebPreloadApi } = await import('./web-preload-api')
      installWebPreloadApi()
      await globals.window.api.settings.set({ uiLanguage: 'ru' })
      expect((await globals.window.api.settings.get()).uiLanguage).toBe('ru')
      expect(JSON.parse(globals.storage.getItem('orca.web.settings.v1') ?? '{}').uiLanguage).toBe(
        'ru'
      )
      expect(calls.filter(({ method }) => method === 'settings.update')).toEqual([])

      vi.resetModules()
      const reloaded = await import('./web-preload-api')
      reloaded.installWebPreloadApi()
      expect(globals.window.api.settings.getSync()?.uiLanguage).toBe('ru')
      expect((await globals.window.api.settings.get()).uiLanguage).toBe('ru')
    }
  )
})
