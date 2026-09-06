import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import {
  installBrowserGlobals,
  writeStoredRuntimeEnvironment
} from './web-preload-api-test-harness'

describe('web collection preload API', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.doUnmock('./web-runtime-client')
  })

  it('routes collection lifecycle calls through the paired runtime', async () => {
    const runtimeCalls: { method: string; params: unknown }[] = []
    const collection = {
      id: 'collection-1',
      name: 'Approve PRs',
      color: null,
      order: 0,
      isCollapsed: false,
      createdAt: 1,
      updatedAt: 1
    }
    vi.doMock('./web-runtime-client', () => ({
      WebRuntimeClient: class {
        call(method: string, params?: unknown): Promise<RuntimeRpcResponse<unknown>> {
          runtimeCalls.push({ method, params })
          const result =
            method === 'collection.list'
              ? { collections: [collection] }
              : method === 'collection.create' || method === 'collection.update'
                ? { collection }
                : { deleted: true }
          return Promise.resolve({
            id: `call-${runtimeCalls.length}`,
            ok: true,
            result,
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

    await expect(globals.window.api.collections.list()).resolves.toEqual([collection])
    await expect(
      globals.window.api.collections.create({ name: 'Approve PRs', color: null })
    ).resolves.toEqual(collection)
    await expect(
      globals.window.api.collections.update({
        collectionId: collection.id,
        updates: { name: 'Approvals' }
      })
    ).resolves.toEqual(collection)
    await expect(
      globals.window.api.collections.delete({ collectionId: collection.id })
    ).resolves.toBe(true)
    expect(runtimeCalls).toEqual([
      { method: 'collection.list', params: undefined },
      { method: 'collection.create', params: { name: 'Approve PRs', color: null } },
      {
        method: 'collection.update',
        params: { collectionId: collection.id, updates: { name: 'Approvals' } }
      },
      { method: 'collection.delete', params: { collectionId: collection.id } }
    ])
  })
})
