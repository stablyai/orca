import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import {
  installApi,
  installBrowserGlobals,
  writeStoredRuntimeEnvironment
} from './web-preload-api-test-harness'

describe('web Portuguese language migration', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it.each(['plugin:stablyai.orca-portuguese/pt-BR', 'en'] as const)(
    'persists the Portuguese receipt and later plugin reselection for %s',
    async (language) => {
      const plugin = 'plugin:stablyai.orca-portuguese/pt-BR'
      const globals = installBrowserGlobals('Linux')
      globals.storage.setItem(
        'orca.web.settings.v1',
        JSON.stringify({
          uiLanguage: language,
          terminalFontSize: 19,
          futureSetting: { retained: true }
        })
      )
      const { installWebPreloadApi } = await import('./web-preload-api')
      installWebPreloadApi()
      const expected = language === plugin ? 'pt' : language
      expect(globals.window.api.settings.getSync()).toMatchObject({
        uiLanguage: expected,
        uiLanguagePortugueseMigrationApplied: true
      })
      expect(await globals.window.api.settings.get()).toMatchObject({ uiLanguage: expected })
      expect(JSON.parse(globals.storage.getItem('orca.web.settings.v1') ?? '{}')).toMatchObject({
        uiLanguage: expected,
        uiLanguagePortugueseMigrationApplied: true,
        terminalFontSize: 19,
        futureSetting: { retained: true }
      })
      await globals.window.api.settings.set({ uiLanguage: plugin })
      await globals.window.api.settings.set({ terminalFontSize: 20 })
      vi.resetModules()
      const reloaded = await import('./web-preload-api')
      reloaded.installWebPreloadApi()
      expect(await globals.window.api.settings.get()).toMatchObject({
        uiLanguage: plugin,
        uiLanguagePortugueseMigrationApplied: true,
        terminalFontSize: 20
      })
    }
  )

  it('stamps fresh browser settings and preserves a fresh plugin choice', async () => {
    const { api, storage } = await installApi('Linux')
    expect(api.settings.getSync()).toMatchObject({
      uiLanguage: 'system',
      uiLanguagePortugueseMigrationApplied: true
    })
    expect(storage.getItem('orca.web.settings.v1')).toBeNull()
    await api.settings.set({ uiLanguage: 'plugin:stablyai.orca-portuguese/pt-BR' })
    expect(await api.settings.get()).toMatchObject({
      uiLanguage: 'plugin:stablyai.orca-portuguese/pt-BR',
      uiLanguagePortugueseMigrationApplied: true
    })
  })

  it.each(['{broken', '[]', 'null', '42', '"text"'])(
    'keeps malformed raw storage untouched: %s',
    async (raw) => {
      const globals = installBrowserGlobals('Linux')
      globals.storage.setItem('orca.web.settings.v1', raw)
      const { installWebPreloadApi } = await import('./web-preload-api')
      installWebPreloadApi()
      expect(globals.window.api.settings.getSync()?.uiLanguagePortugueseMigrationApplied).toBe(true)
      expect((await globals.window.api.settings.get()).uiLanguagePortugueseMigrationApplied).toBe(
        true
      )
      expect(globals.storage.getItem('orca.web.settings.v1')).toBe(raw)
    }
  )

  it.each([false, true])(
    'keeps language and receipt local with runtime offline=%s',
    async (offline) => {
      const runtimeCalls: { method: string; params: unknown }[] = []
      vi.doMock('./web-runtime-client', () => ({
        WebRuntimeClient: class {
          call(method: string, params?: unknown): Promise<RuntimeRpcResponse<unknown>> {
            runtimeCalls.push({ method, params })
            if (offline) {
              return Promise.reject(new Error('offline'))
            }
            return Promise.resolve({
              id: 'old-runtime',
              ok: true,
              result: { settings: {} },
              _meta: { runtimeId: 'old-runtime' }
            })
          }
          close(): void {}
        }
      }))
      const globals = installBrowserGlobals('Linux')
      writeStoredRuntimeEnvironment(globals.storage)
      globals.storage.setItem(
        'orca.web.settings.v1',
        JSON.stringify({
          uiLanguage: 'plugin:stablyai.orca-portuguese/pt-BR'
        })
      )
      const { installWebPreloadApi } = await import('./web-preload-api')
      installWebPreloadApi()
      expect((await globals.window.api.settings.get()).uiLanguage).toBe('pt')
      await globals.window.api.settings.set({ uiLanguage: 'plugin:stablyai.orca-portuguese/pt-BR' })
      await globals.window.api.settings.set({ compactWorktreeCards: true })
      expect((await globals.window.api.settings.get()).uiLanguage).toBe(
        'plugin:stablyai.orca-portuguese/pt-BR'
      )
      expect(runtimeCalls.filter((call) => call.method === 'settings.update')).toEqual([
        { method: 'settings.update', params: { compactWorktreeCards: true } }
      ])
    }
  )
})
