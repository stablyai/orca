import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeRpcResponse } from '../../../../../shared/remote-runtime/rpc/runtime-rpc-envelope'
import {
  installBrowserGlobals,
  writeStoredRuntimeEnvironment
} from '../../testing/web-preload-api-test-harness'

describe('web settings preload API', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('keeps a completed settings merge when the paired host is removed mid-read', async () => {
    let resolveSettings!: (value: RuntimeRpcResponse<unknown>) => void
    const settingsRead = new Promise<RuntimeRpcResponse<unknown>>(
      (resolve) => (resolveSettings = resolve)
    )
    vi.doMock('../../runtime/client/web-runtime-client', () => ({
      WebRuntimeClient: class {
        call(): Promise<RuntimeRpcResponse<unknown>> {
          return settingsRead
        }

        close(): void {}
      }
    }))

    const globals = installBrowserGlobals('Linux')
    writeStoredRuntimeEnvironment(globals.storage)
    globals.storage.setItem(
      'orca.web.settings.v1',
      JSON.stringify({ worktreeVisibilityDefaults: { external: 'hide' } })
    )
    const { installWebPreloadApi } = await import('../../web-preload-api')
    installWebPreloadApi()
    const environment = (await globals.window.api.runtimeEnvironments.list())[0]!
    const read = globals.window.api.settings.get()

    await globals.window.api.runtimeEnvironments.remove({ selector: environment.id })
    resolveSettings({
      id: 'settings-read',
      ok: true,
      result: {
        settings: {
          compactWorktreeCards: true,
          worktreeVisibilityDefaults: { external: 'show' }
        }
      },
      _meta: { runtimeId: 'runtime-1' }
    })

    await expect(read).resolves.toMatchObject({
      compactWorktreeCards: true,
      worktreeVisibilityDefaults: { external: 'hide' }
    })
    expect(JSON.parse(globals.storage.getItem('orca.web.settings.v1') ?? '{}')).toMatchObject({
      compactWorktreeCards: true,
      worktreeVisibilityDefaults: { external: 'hide' }
    })
  })

  it('hydrates and updates worktree source defaults owned by a paired runtime', async () => {
    const runtimeCalls: { method: string; params: unknown }[] = []
    vi.doMock('../../runtime/client/web-runtime-client', () => ({
      WebRuntimeClient: class {
        call(method: string, params?: unknown): Promise<RuntimeRpcResponse<unknown>> {
          runtimeCalls.push({ method, params })
          const sourcePreferences =
            method === 'settings.update'
              ? { builtIn: { claude: 'show' as const } }
              : { builtIn: { claude: 'hide' as const } }
          return Promise.resolve({
            id: `call-${runtimeCalls.length}`,
            ok: true,
            result: {
              settings: {
                worktreeVisibilityDefaults: {
                  external: method === 'settings.update' ? 'show' : 'hide',
                  customSources: [{ id: 'remote', rootPath: '/srv/remote' }],
                  sourcePreferences
                }
              }
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
      'orca.web.settings.v1',
      JSON.stringify({
        worktreeVisibilityDefaults: {
          external: 'show',
          customSources: [{ id: 'local', rootPath: '/srv/local' }]
        }
      })
    )
    const { installWebPreloadApi } = await import('../../web-preload-api')
    installWebPreloadApi()

    expect((await globals.window.api.settings.get()).worktreeVisibilityDefaults).toEqual({
      external: 'hide',
      customSources: [{ id: 'remote', rootPath: '/srv/remote' }],
      sourcePreferences: { builtIn: { claude: 'hide' } }
    })
    expect(
      JSON.parse(globals.storage.getItem('orca.web.settings.v1') ?? '{}').worktreeVisibilityDefaults
    ).toEqual({
      external: 'show',
      customSources: [{ id: 'local', rootPath: '/srv/local' }]
    })
    expect(
      (
        await globals.window.api.settings.set({
          worktreeVisibilityDefaults: {
            external: 'show',
            sourcePreferences: { builtIn: { claude: 'show' } }
          }
        })
      ).worktreeVisibilityDefaults
    ).toEqual({
      external: 'show',
      customSources: [{ id: 'remote', rootPath: '/srv/remote' }],
      sourcePreferences: { builtIn: { claude: 'show' } }
    })
    expect(
      JSON.parse(globals.storage.getItem('orca.web.settings.v1') ?? '{}').worktreeVisibilityDefaults
    ).toEqual({
      external: 'show',
      customSources: [{ id: 'local', rootPath: '/srv/local' }]
    })
    expect(runtimeCalls).toEqual([
      { method: 'settings.get', params: undefined },
      {
        method: 'settings.update',
        params: {
          worktreeVisibilityDefaults: {
            external: 'show',
            customSources: [{ id: 'remote', rootPath: '/srv/remote' }],
            sourcePreferences: { builtIn: { claude: 'show' } }
          }
        }
      }
    ])
  })

  it('rejects a failed paired visibility write after preserving local-only fields', async () => {
    vi.doMock('../../runtime/client/web-runtime-client', () => ({
      WebRuntimeClient: class {
        call(method: string): Promise<RuntimeRpcResponse<unknown>> {
          if (method === 'settings.update') {
            return Promise.reject(new Error('offline'))
          }
          return Promise.resolve({
            id: method,
            ok: true,
            result: {
              settings: { worktreeVisibilityDefaults: { external: 'hide' } }
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
      'orca.web.settings.v1',
      JSON.stringify({ worktreeVisibilityDefaults: { external: 'show' } })
    )
    const { installWebPreloadApi } = await import('../../web-preload-api')
    installWebPreloadApi()
    await globals.window.api.settings.get()

    await expect(
      globals.window.api.settings.set({
        terminalFontSize: 15,
        worktreeVisibilityDefaults: { external: 'show' }
      })
    ).rejects.toThrow('offline')

    expect(JSON.parse(globals.storage.getItem('orca.web.settings.v1') ?? '{}')).toMatchObject({
      terminalFontSize: 15,
      worktreeVisibilityDefaults: { external: 'show' }
    })
  })

  it('keeps a confirmed Azure DevOps write when an older settings read arrives late', async () => {
    let markReadStarted!: () => void
    let releaseRead!: () => void
    const readStarted = new Promise<void>((resolve) => (markReadStarted = resolve))
    const readHeld = new Promise<void>((resolve) => (releaseRead = resolve))
    let holdNextRead = false
    vi.doMock('../../runtime/client/web-runtime-client', () => ({
      WebRuntimeClient: class {
        readonly connectionEpoch = 1

        async call(method: string): Promise<RuntimeRpcResponse<unknown>> {
          if (method === 'settings.get' && holdNextRead) {
            holdNextRead = false
            markReadStarted()
            await readHeld
          }
          return {
            id: method,
            ok: true,
            result: {
              settings: {
                azureDevOpsAuthMethod: method === 'settings.update' ? 'azure-cli' : 'environment'
              }
            },
            _meta: { runtimeId: 'runtime-1' }
          }
        }

        close(): void {}
      }
    }))

    const globals = installBrowserGlobals('Linux')
    writeStoredRuntimeEnvironment(globals.storage)
    const { installWebPreloadApi } = await import('../../web-preload-api')
    installWebPreloadApi()
    const { settings } = globals.window.api
    await expect(settings.get()).resolves.toMatchObject({ azureDevOpsAuthMethod: 'environment' })

    holdNextRead = true
    const staleRead = settings.get()
    await readStarted
    try {
      await expect(settings.set({ azureDevOpsAuthMethod: 'azure-cli' })).resolves.toMatchObject({
        azureDevOpsAuthMethod: 'azure-cli'
      })
    } finally {
      releaseRead()
    }

    await expect(staleRead).resolves.toMatchObject({ azureDevOpsAuthMethod: 'azure-cli' })
    await expect(settings.get()).resolves.toMatchObject({ azureDevOpsAuthMethod: 'environment' })
  })

  it('does not read or write an Azure DevOps method on behalf of an older host', async () => {
    const call = vi.fn(async (method: string): Promise<RuntimeRpcResponse<unknown>> => ({
      id: method,
      ok: true,
      result: { settings: {} },
      _meta: { runtimeId: 'legacy-runtime' }
    }))
    vi.doMock('../../runtime/client/web-runtime-client', () => ({
      WebRuntimeClient: class {
        call = call

        close(): void {}
      }
    }))

    const globals = installBrowserGlobals('Linux')
    writeStoredRuntimeEnvironment(globals.storage)
    globals.storage.setItem('orca.web.settings.v1', '{"azureDevOpsAuthMethod":"azure-cli"}')
    const { installWebPreloadApi } = await import('../../web-preload-api')
    installWebPreloadApi()

    expect((await globals.window.api.settings.get()).azureDevOpsAuthMethod).toBeUndefined()
    await expect(
      globals.window.api.settings.set({ azureDevOpsAuthMethod: 'azure-cli' })
    ).rejects.toBeInstanceOf(Error)
    expect(call.mock.calls.map(([method]) => method)).not.toContain('settings.update')
    expect(JSON.parse(globals.storage.getItem('orca.web.settings.v1') ?? '{}')).not.toHaveProperty(
      'azureDevOpsAuthMethod'
    )
  })
})
