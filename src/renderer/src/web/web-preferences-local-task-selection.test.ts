import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import {
  installBrowserGlobals,
  writeStoredRuntimeEnvironment
} from './web-preload-api-test-harness'

describe('browser-local exact Tasks selection across remote replies', () => {
  beforeEach(() => vi.resetModules())
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.doUnmock('./web-runtime-client')
  })
  it.each(['read', 'write', 'bot', 'failed-read', 'failed-write'] as const)(
    'retains current browser-local exact Tasks selection across a delayed %s full reply and environment switch',
    async (route) => {
      let settle!: (response: RuntimeRpcResponse<unknown>) => void
      let reject!: (error: Error) => void
      const reply = new Promise<RuntimeRpcResponse<unknown>>((resolve, fail) => {
        settle = resolve
        reject = fail
      })
      const calls: string[] = []
      vi.doMock('./web-runtime-client', () => ({
        WebRuntimeClient: class {
          call(method: string): Promise<RuntimeRpcResponse<unknown>> {
            calls.push(method)
            return reply
          }
          close(): void {}
        }
      }))
      const globals = installBrowserGlobals('Linux')
      writeStoredRuntimeEnvironment(globals.storage)
      globals.storage.setItem(
        'orca.web.settings.v1',
        JSON.stringify({ defaultRepoSelection: ['old'] })
      )
      const { installWebPreloadApi } = await import('./web-preload-api')
      installWebPreloadApi()
      const api = globals.window.api
      const environment = (await api.runtimeEnvironments.list())[0]!
      const pending = route.includes('read')
        ? api.settings.get()
        : route === 'bot'
          ? api.settings.updatePRBotAuthorOverride({ author: 'gretelflux', isBot: true })
          : api.settings.set({ compactWorktreeCards: true })
      const exact = ['runtime:server\0same']
      await api.settings.set({ defaultRepoSelection: exact })
      await api.runtimeEnvironments.remove({ selector: environment.id })
      if (route.startsWith('failed-')) {
        reject(new Error('offline'))
      } else {
        settle({
          id: 'delayed',
          ok: true,
          result: {
            settings: {
              defaultRepoSelection: ['same'],
              compactWorktreeCards: true,
              prBotAuthorOverrides: ['gretelflux']
            }
          },
          _meta: { runtimeId: 'runtime-1' }
        })
      }
      expect((await pending).defaultRepoSelection).toEqual(exact)
      expect(api.settings.getSync()?.defaultRepoSelection).toEqual(exact)
      expect(
        JSON.parse(globals.storage.getItem('orca.web.settings.v1') ?? '{}').defaultRepoSelection
      ).toEqual(exact)
      expect(calls).toHaveLength(1)
    }
  )
})
