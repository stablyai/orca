import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  installBrowserGlobals,
  writeStoredRuntimeEnvironment
} from './web-preload-api-test-harness'
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'

beforeEach(() => vi.resetModules())
afterEach(() => {
  vi.unstubAllGlobals()
  vi.doUnmock('./web-runtime-client')
})

it('preserves legacy search results and surfaces old-host or disconnected errors without local fallback', async () => {
  const calls: { method: string; params: unknown }[] = []
  let failure: string | null = null
  const legacy = {
    hits: [],
    route: 'or',
    durationMs: 1,
    coverage: {
      sessionsIndexed: 1,
      messagesIndexed: 2,
      providers: [],
      backfill: 'complete',
      filesPending: 0,
      lastIndexedAt: null
    }
  }
  vi.doMock('./web-runtime-client', () => ({
    WebRuntimeClient: class {
      call(method: string, params: unknown): Promise<RuntimeRpcResponse<unknown>> {
        calls.push({ method, params })
        return Promise.resolve(
          failure
            ? {
                id: 'fixture',
                _meta: { runtimeId: 'host-a' },
                ok: false,
                error: { code: failure, message: failure }
              }
            : { id: 'fixture', _meta: { runtimeId: 'host-a' }, ok: true, result: legacy }
        )
      }
      close(): void {}
    }
  }))
  const globals = installBrowserGlobals('Linux')
  writeStoredRuntimeEnvironment(globals.storage, 'host-a')
  const { installWebPreloadApi } = await import('./web-preload-api')
  installWebPreloadApi()
  await expect(globals.window.api.aiVault.searchSessions({ query: 'needle' })).resolves.toEqual(
    legacy
  )
  expect(calls).toEqual([
    {
      method: 'aiVault.searchSessions',
      params: { query: 'needle', executionHostId: 'runtime:host-a' }
    }
  ])
  for (const error of ['method_not_found', 'connection_closed']) {
    failure = error
    await expect(
      globals.window.api.aiVault.searchSessions({ query: 'needle' })
    ).rejects.toMatchObject({ code: error })
  }
  expect(calls).toHaveLength(3)
  expect(calls.every((call) => call.method === 'aiVault.searchSessions')).toBe(true)
})
