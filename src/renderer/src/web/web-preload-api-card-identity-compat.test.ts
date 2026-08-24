import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { WORKTREE_CARD_IDENTITY_PROPERTIES_RUNTIME_CAPABILITY } from '../../../shared/protocol-version'
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import {
  installBrowserGlobals,
  writeStoredRuntimeEnvironment
} from './web-preload-api-test-harness'

describe('web UI card identity compatibility', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.doUnmock('./web-runtime-client')
  })

  it('keeps identity choices local while paired to a legacy host', async () => {
    const runtimeCalls: { method: string; params: unknown }[] = []
    vi.doMock('./web-runtime-client', () => ({
      WebRuntimeClient: class {
        call(method: string, params?: unknown): Promise<RuntimeRpcResponse<unknown>> {
          runtimeCalls.push({ method, params })
          return Promise.resolve({
            id: method,
            ok: true,
            result: { ui: { worktreeCardProperties: ['status', 'pr'] } },
            _meta: { runtimeId: 'runtime-1' }
          })
        }

        close(): void {}
      }
    }))

    const globals = installBrowserGlobals('Linux')
    writeStoredRuntimeEnvironment(globals.storage)
    globals.storage.setItem(
      'orca.web.ui.v1',
      JSON.stringify({ worktreeCardProperties: ['status', 'project-name'] })
    )
    const { installWebPreloadApi } = await import('./web-preload-api')
    installWebPreloadApi()

    await expect(globals.window.api.ui.get()).resolves.toMatchObject({
      worktreeCardProperties: ['status', 'unread', 'pr', 'project-name']
    })
    await globals.window.api.ui.set({ worktreeCardProperties: ['status', 'host-name'] })

    expect(runtimeCalls.at(-1)).toEqual({
      method: 'ui.set',
      params: { worktreeCardProperties: ['status'] }
    })
    expect(
      JSON.parse(globals.storage.getItem('orca.web.pendingIdentityCardProperties.v1') ?? '{}')
    ).toEqual({ properties: ['host-name'] })
  })

  it('syncs a pending identity choice after the host gains support', async () => {
    const runtimeCalls: { method: string; params: unknown }[] = []
    vi.doMock('./web-runtime-client', () => ({
      WebRuntimeClient: class {
        call(method: string, params?: unknown): Promise<RuntimeRpcResponse<unknown>> {
          runtimeCalls.push({ method, params })
          return Promise.resolve({
            id: method,
            ok: true,
            result: {
              ui: {
                worktreeCardProperties:
                  method === 'ui.set'
                    ? ['status', 'unread']
                    : ['status', 'unread', 'project-name', 'host-name']
              },
              capabilities: [WORKTREE_CARD_IDENTITY_PROPERTIES_RUNTIME_CAPABILITY]
            },
            _meta: { runtimeId: 'runtime-1' }
          })
        }

        close(): void {}
      }
    }))

    const globals = installBrowserGlobals('Linux')
    writeStoredRuntimeEnvironment(globals.storage)
    globals.storage.setItem(
      'orca.web.pendingIdentityCardProperties.v1',
      JSON.stringify({ properties: [] })
    )
    const { installWebPreloadApi } = await import('./web-preload-api')
    installWebPreloadApi()

    await expect(globals.window.api.ui.get()).resolves.toMatchObject({
      worktreeCardProperties: ['status', 'unread']
    })
    expect(runtimeCalls).toContainEqual({
      method: 'ui.set',
      params: { worktreeCardProperties: ['status', 'unread'] }
    })
    expect(globals.storage.getItem('orca.web.pendingIdentityCardProperties.v1')).toBeNull()
  })
})
