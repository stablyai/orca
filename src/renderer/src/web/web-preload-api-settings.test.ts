import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import {
  installBrowserGlobals,
  writeStoredRuntimeEnvironment
} from './web-preload-api-test-harness'

describe('web settings preload API', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('reads the paired host details row preference and writes changes back to that host', async () => {
    const runtimeCalls: { method: string; params: unknown }[] = []
    vi.doMock('./web-runtime-client', () => ({
      WebRuntimeClient: class {
        call(method: string, params?: unknown): Promise<RuntimeRpcResponse<unknown>> {
          runtimeCalls.push({ method, params })
          return Promise.resolve({
            id: 'settings',
            ok: true,
            result: {
              settings: {
                worktreeCardStyle: 'experimental-2',
                worktreeCardDetailsRow: method === 'settings.update'
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
      JSON.stringify({ worktreeCardDetailsRow: true })
    )
    const { installWebPreloadApi } = await import('./web-preload-api')
    installWebPreloadApi()
    expect((await globals.window.api.settings.get()).worktreeCardDetailsRow).toBe(false)
    expect(
      (await globals.window.api.settings.set({ worktreeCardDetailsRow: true }))
        .worktreeCardDetailsRow
    ).toBe(true)
    expect(runtimeCalls.find((call) => call.method === 'settings.update')?.params).toMatchObject({
      worktreeCardDetailsRow: true
    })
  })

  it('arms the OSC 52 notice when ui.get is the read that runs the migration', async () => {
    // Seed after module load to model another tab’s storage update; first ui.get must migrate settings before snapshotting UI or it erases the one-shot notice arm.
    const globals = installBrowserGlobals('Linux')
    const { installWebPreloadApi } = await import('./web-preload-api')
    installWebPreloadApi()
    globals.storage.setItem(
      'orca.web.settings.v1',
      JSON.stringify({ terminalAllowOsc52Clipboard: false })
    )

    const ui = await globals.window.api.ui.get()

    expect(ui.osc52ClipboardDefaultOnNoticePending).toBe(true)
  })

  it('keeps a completed settings merge when the paired host is removed mid-read', async () => {
    let resolveSettings!: (value: RuntimeRpcResponse<unknown>) => void
    const settingsRead = new Promise<RuntimeRpcResponse<unknown>>(
      (resolve) => (resolveSettings = resolve)
    )
    vi.doMock('./web-runtime-client', () => ({
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
    const { installWebPreloadApi } = await import('./web-preload-api')
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
    vi.doMock('./web-runtime-client', () => ({
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
    const { installWebPreloadApi } = await import('./web-preload-api')
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
    vi.doMock('./web-runtime-client', () => ({
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
    const { installWebPreloadApi } = await import('./web-preload-api')
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
})
