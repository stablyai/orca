import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import {
  installApi,
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

  it('migrates first-work branch auto-rename on for stored legacy web settings once', async () => {
    const globals = installBrowserGlobals('Linux')
    globals.storage.setItem(
      'orca.web.settings.v1',
      JSON.stringify({ autoRenameBranchFromWork: false })
    )
    const { installWebPreloadApi } = await import('./web-preload-api')
    installWebPreloadApi()

    const settings = await globals.window.api.settings.get()
    const stored = JSON.parse(globals.storage.getItem('orca.web.settings.v1') ?? '{}') as {
      autoRenameBranchFromWork?: boolean
      autoRenameBranchFromWorkDefaultedOn?: boolean
    }

    expect(settings.autoRenameBranchFromWork).toBe(true)
    expect(settings.autoRenameBranchFromWorkDefaultedOn).toBe(true)
    expect(stored.autoRenameBranchFromWork).toBe(true)
    expect(stored.autoRenameBranchFromWorkDefaultedOn).toBe(true)
  })

  it('migrates inherited terminal bar cursor defaults for stored web settings once', async () => {
    const globals = installBrowserGlobals('Linux')
    globals.storage.setItem('orca.web.settings.v1', JSON.stringify({ terminalCursorStyle: 'bar' }))
    const { installWebPreloadApi } = await import('./web-preload-api')
    installWebPreloadApi()

    const settings = await globals.window.api.settings.get()
    const stored = JSON.parse(globals.storage.getItem('orca.web.settings.v1') ?? '{}') as {
      terminalCursorStyle?: string
      terminalCursorStyleDefaultedToBlock?: boolean
    }

    expect(settings.terminalCursorStyle).toBe('block')
    expect(settings.terminalCursorStyleDefaultedToBlock).toBe(true)
    expect(stored.terminalCursorStyle).toBe('block')
    expect(stored.terminalCursorStyleDefaultedToBlock).toBe(true)
  })

  it('preserves terminal cursor choices after the web block-default migration', async () => {
    const globals = installBrowserGlobals('Linux')
    globals.storage.setItem(
      'orca.web.settings.v1',
      JSON.stringify({
        terminalCursorStyle: 'bar',
        terminalCursorStyleDefaultedToBlock: true
      })
    )
    const { installWebPreloadApi } = await import('./web-preload-api')
    installWebPreloadApi()

    const settings = await globals.window.api.settings.get()
    expect(settings.terminalCursorStyle).toBe('bar')
    expect(settings.terminalCursorStyleDefaultedToBlock).toBe(true)
  })

  it('mirrors the host-owned agent skill sharing capability without granting it', async () => {
    const runtimeCalls: { method: string; params: unknown }[] = []
    vi.doMock('./web-runtime-client', () => ({
      WebRuntimeClient: class {
        call(method: string, params?: unknown): Promise<RuntimeRpcResponse<unknown>> {
          runtimeCalls.push({ method, params })
          return Promise.resolve({
            id: `call-${runtimeCalls.length}`,
            ok: true,
            result: { settings: { agentSkillSharingEnabled: false } },
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

    const settings = await globals.window.api.settings.get()
    await globals.window.api.settings.set({ agentSkillSharingEnabled: true })
    const refreshed = await globals.window.api.settings.get()

    expect(settings.agentSkillSharingEnabled).toBe(false)
    expect(refreshed.agentSkillSharingEnabled).toBe(false)
    expect(runtimeCalls).toEqual([
      { method: 'settings.get', params: { includeAgentCatalog: false } },
      { method: 'settings.get', params: { includeAgentCatalog: false } }
    ])
    expect(runtimeCalls).not.toContainEqual(expect.objectContaining({ method: 'settings.update' }))
  })

  it('normalizes terminal cursor style before web settings writes return or persist', async () => {
    const { api, storage } = await installApi('Linux')

    const invalid = await api.settings.set({ terminalCursorStyle: 'beam' as never })
    const invalidStored = JSON.parse(storage.getItem('orca.web.settings.v1') ?? '{}') as {
      terminalCursorStyle?: string
      terminalCursorStyleDefaultedToBlock?: boolean
    }
    expect(invalid.terminalCursorStyle).toBe('block')
    expect(invalid.terminalCursorStyleDefaultedToBlock).toBe(true)
    expect(invalidStored.terminalCursorStyle).toBe('block')
    expect(invalidStored.terminalCursorStyleDefaultedToBlock).toBe(true)

    const valid = await api.settings.set({ terminalCursorStyle: 'bar' })
    expect(valid.terminalCursorStyle).toBe('bar')
    expect(JSON.parse(storage.getItem('orca.web.settings.v1') ?? '{}').terminalCursorStyle).toBe(
      'bar'
    )
  })

  it('migrates OSC 52 clipboard writes on for stored web settings once', async () => {
    // Why: the web store is a second, independent settings store — the constants-level
    // default flip only reaches profiles that never persisted the old `false` (#10567).
    const globals = installBrowserGlobals('Linux')
    globals.storage.setItem(
      'orca.web.settings.v1',
      JSON.stringify({ terminalAllowOsc52Clipboard: false })
    )
    const { installWebPreloadApi } = await import('./web-preload-api')
    installWebPreloadApi()

    const settings = await globals.window.api.settings.get()
    const stored = JSON.parse(globals.storage.getItem('orca.web.settings.v1') ?? '{}') as {
      terminalAllowOsc52Clipboard?: boolean
      terminalAllowOsc52ClipboardDefaultedOnForAllUsers?: boolean
    }

    expect(settings.terminalAllowOsc52Clipboard).toBe(true)
    expect(settings.terminalAllowOsc52ClipboardDefaultedOnForAllUsers).toBe(true)
    expect(stored.terminalAllowOsc52Clipboard).toBe(true)
    expect(stored.terminalAllowOsc52ClipboardDefaultedOnForAllUsers).toBe(true)
  })

  it('arms the OSC 52 notice in the web UI store when the flip overrides a persisted off', async () => {
    const globals = installBrowserGlobals('Linux')
    globals.storage.setItem(
      'orca.web.settings.v1',
      JSON.stringify({ terminalAllowOsc52Clipboard: false })
    )
    const { installWebPreloadApi } = await import('./web-preload-api')
    installWebPreloadApi()

    await globals.window.api.settings.get()
    const storedUi = JSON.parse(globals.storage.getItem('orca.web.ui.v1') ?? '{}') as {
      osc52ClipboardDefaultOnNoticePending?: boolean
    }

    expect(storedUi.osc52ClipboardDefaultOnNoticePending).toBe(true)
  })

  it('does not arm the OSC 52 notice for a web profile with no persisted value', async () => {
    const globals = installBrowserGlobals('Linux')
    globals.storage.setItem('orca.web.settings.v1', JSON.stringify({ terminalFontSize: 15 }))
    const { installWebPreloadApi } = await import('./web-preload-api')
    installWebPreloadApi()

    await globals.window.api.settings.get()
    const storedUi = JSON.parse(globals.storage.getItem('orca.web.ui.v1') ?? '{}') as {
      osc52ClipboardDefaultOnNoticePending?: boolean
    }

    expect(storedUi.osc52ClipboardDefaultOnNoticePending).not.toBe(true)
  })

  it('arms the OSC 52 notice when ui.get is the read that runs the migration', async () => {
    // Why seed after install: readLocalWebUIState must run the settings migration before it
    // snapshots the UI blob, and only a ui.get that is itself the first settings read can
    // show that. Reading first returns a pre-arm state every caller then writes back — and
    // the stamp means nothing can raise the arm again. Another tab populating localStorage
    // after this one loaded is the shape that reaches it.
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

  it('preserves OSC 52 clipboard web opt-outs after migration', async () => {
    const globals = installBrowserGlobals('Linux')
    globals.storage.setItem(
      'orca.web.settings.v1',
      JSON.stringify({
        terminalAllowOsc52Clipboard: false,
        terminalAllowOsc52ClipboardDefaultedOnForAllUsers: true
      })
    )
    const { installWebPreloadApi } = await import('./web-preload-api')
    installWebPreloadApi()

    const settings = await globals.window.api.settings.get()
    expect(settings.terminalAllowOsc52Clipboard).toBe(false)
    expect(settings.terminalAllowOsc52ClipboardDefaultedOnForAllUsers).toBe(true)
  })

  it('preserves first-work branch auto-rename web opt-outs after migration', async () => {
    const globals = installBrowserGlobals('Linux')
    globals.storage.setItem(
      'orca.web.settings.v1',
      JSON.stringify({
        autoRenameBranchFromWork: false,
        autoRenameBranchFromWorkDefaultedOn: true
      })
    )
    const { installWebPreloadApi } = await import('./web-preload-api')
    installWebPreloadApi()

    const settings = await globals.window.api.settings.get()
    const stored = JSON.parse(globals.storage.getItem('orca.web.settings.v1') ?? '{}') as {
      autoRenameBranchFromWork?: boolean
      autoRenameBranchFromWorkDefaultedOn?: boolean
    }

    expect(settings.autoRenameBranchFromWork).toBe(false)
    expect(settings.autoRenameBranchFromWorkDefaultedOn).toBe(true)
    expect(stored.autoRenameBranchFromWork).toBe(false)
    expect(stored.autoRenameBranchFromWorkDefaultedOn).toBe(true)
  })

  it('stamps the first-work branch auto-rename guard for web setting updates', async () => {
    const { api, storage } = await installApi('Linux')

    const settings = await api.settings.set({ autoRenameBranchFromWork: false })
    const stored = JSON.parse(storage.getItem('orca.web.settings.v1') ?? '{}') as {
      autoRenameBranchFromWork?: boolean
      autoRenameBranchFromWorkDefaultedOn?: boolean
    }

    expect(settings.autoRenameBranchFromWork).toBe(false)
    expect(settings.autoRenameBranchFromWorkDefaultedOn).toBe(true)
    expect(stored.autoRenameBranchFromWork).toBe(false)
    expect(stored.autoRenameBranchFromWorkDefaultedOn).toBe(true)
  })

  it('hydrates compact worktree cards from paired runtime settings', async () => {
    const runtimeCalls: { method: string; params: unknown }[] = []
    vi.doMock('./web-runtime-client', () => ({
      WebRuntimeClient: class {
        call(method: string, params?: unknown): Promise<RuntimeRpcResponse<unknown>> {
          runtimeCalls.push({ method, params })
          return Promise.resolve({
            id: `call-${runtimeCalls.length}`,
            ok: true,
            result: {
              settings: {
                compactWorktreeCards: true,
                activeRuntimeEnvironmentId: 'host-internal-default'
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
    const { installWebPreloadApi } = await import('./web-preload-api')
    installWebPreloadApi()

    const settings = await globals.window.api.settings.get()
    const stored = JSON.parse(globals.storage.getItem('orca.web.settings.v1') ?? '{}') as {
      compactWorktreeCards?: boolean
    }

    expect(settings.compactWorktreeCards).toBe(true)
    expect(settings.activeRuntimeEnvironmentId).toBeNull()
    expect(stored.compactWorktreeCards).toBe(true)
    expect(stored).not.toHaveProperty('activeRuntimeEnvironmentId')
    expect(runtimeCalls).toEqual([
      { method: 'settings.get', params: { includeAgentCatalog: false } }
    ])
  }, 15_000)

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
      { method: 'settings.get', params: { includeAgentCatalog: false } },
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

  it('does not persist a paired runtime visibility update as the local default', async () => {
    vi.doMock('./web-runtime-client', () => ({
      WebRuntimeClient: class {
        call(method: string): Promise<RuntimeRpcResponse<unknown>> {
          return Promise.resolve({
            id: method,
            ok: true,
            result: {
              settings: {
                worktreeVisibilityDefaults: {
                  external: method === 'settings.update' ? 'show' : 'hide'
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
      JSON.stringify({ worktreeVisibilityDefaults: { external: 'hide' } })
    )
    const { installWebPreloadApi } = await import('./web-preload-api')
    installWebPreloadApi()
    await globals.window.api.settings.get()

    await globals.window.api.settings.set({
      worktreeVisibilityDefaults: { external: 'show' }
    })

    expect(
      JSON.parse(globals.storage.getItem('orca.web.settings.v1') ?? '{}').worktreeVisibilityDefaults
    ).toEqual({ external: 'hide' })
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

  it('does not send the additive visibility field to an older paired runtime', async () => {
    const runtimeCalls: { method: string; params: unknown }[] = []
    vi.doMock('./web-runtime-client', () => ({
      WebRuntimeClient: class {
        call(method: string, params?: unknown): Promise<RuntimeRpcResponse<unknown>> {
          runtimeCalls.push({ method, params })
          return Promise.resolve({
            id: `call-${runtimeCalls.length}`,
            ok: true,
            result: { settings: {} },
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

    expect((await globals.window.api.settings.get()).worktreeVisibilityDefaults).toBeUndefined()
    const settings = await globals.window.api.settings.set({
      worktreeVisibilityDefaults: { external: 'show' }
    })

    expect(settings.worktreeVisibilityDefaults).toBeUndefined()
    expect(runtimeCalls).toEqual([
      { method: 'settings.get', params: { includeAgentCatalog: false } }
    ])
  })

  it('hydrates new worktree card style from a paired runtime', async () => {
    const runtimeCalls: { method: string; params: unknown }[] = []
    vi.doMock('./web-runtime-client', () => ({
      WebRuntimeClient: class {
        call(method: string, params?: unknown): Promise<RuntimeRpcResponse<unknown>> {
          runtimeCalls.push({ method, params })
          return Promise.resolve({
            id: `call-${runtimeCalls.length}`,
            ok: true,
            result: { settings: { experimentalNewWorktreeCardStyle: true } },
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

    const settings = await globals.window.api.settings.get()
    const stored = JSON.parse(globals.storage.getItem('orca.web.settings.v1') ?? '{}') as {
      experimentalNewWorktreeCardStyle?: boolean
    }

    expect(settings.experimentalNewWorktreeCardStyle).toBe(true)
    expect(stored.experimentalNewWorktreeCardStyle).toBe(true)
    expect(runtimeCalls).toEqual([
      { method: 'settings.get', params: { includeAgentCatalog: false } }
    ])
  })

  it('hydrates MiniMax usage settings from a paired runtime', async () => {
    const runtimeCalls: { method: string; params: unknown }[] = []
    vi.doMock('./web-runtime-client', () => ({
      WebRuntimeClient: class {
        call(method: string, params?: unknown): Promise<RuntimeRpcResponse<unknown>> {
          runtimeCalls.push({ method, params })
          return Promise.resolve({
            id: `call-${runtimeCalls.length}`,
            ok: true,
            result: {
              settings: {
                minimaxGroupId: 'group-42',
                minimaxUsageModels: 'general,abab6.5'
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
    const { installWebPreloadApi } = await import('./web-preload-api')
    installWebPreloadApi()

    const settings = await globals.window.api.settings.get()
    const stored = JSON.parse(globals.storage.getItem('orca.web.settings.v1') ?? '{}') as {
      minimaxGroupId?: string
      minimaxUsageModels?: string
    }

    expect(settings.minimaxGroupId).toBe('group-42')
    expect(settings.minimaxUsageModels).toBe('general,abab6.5')
    expect(stored.minimaxGroupId).toBe('group-42')
    expect(stored.minimaxUsageModels).toBe('general,abab6.5')
    expect(runtimeCalls).toEqual([
      { method: 'settings.get', params: { includeAgentCatalog: false } }
    ])
  })

  it('hydrates bot-author overrides from paired runtime settings', async () => {
    const runtimeCalls: { method: string; params: unknown }[] = []
    vi.doMock('./web-runtime-client', () => ({
      WebRuntimeClient: class {
        call(method: string, params?: unknown): Promise<RuntimeRpcResponse<unknown>> {
          runtimeCalls.push({ method, params })
          return Promise.resolve({
            id: 'call-1',
            ok: true,
            result: { settings: { prBotAuthorOverrides: [' GretelFlux ', 'gretelflux'] } },
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

    const settings = await globals.window.api.settings.get()

    expect(settings.prBotAuthorOverrides).toEqual(['gretelflux'])
    expect(runtimeCalls).toEqual([
      { method: 'settings.get', params: { includeAgentCatalog: false } }
    ])
  })

  it('forwards compact worktree card updates to a paired runtime', async () => {
    const runtimeCalls: { method: string; params: unknown }[] = []
    vi.doMock('./web-runtime-client', () => ({
      WebRuntimeClient: class {
        call(method: string, params?: unknown): Promise<RuntimeRpcResponse<unknown>> {
          runtimeCalls.push({ method, params })
          return Promise.resolve({
            id: `call-${runtimeCalls.length}`,
            ok: true,
            result: {
              settings: {
                compactWorktreeCards: true,
                activeRuntimeEnvironmentId: 'host-internal-default'
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
    const { installWebPreloadApi } = await import('./web-preload-api')
    installWebPreloadApi()

    const settings = await globals.window.api.settings.set({ compactWorktreeCards: true })

    const stored = JSON.parse(globals.storage.getItem('orca.web.settings.v1') ?? '{}') as {
      compactWorktreeCards?: boolean
    }

    expect(settings.compactWorktreeCards).toBe(true)
    expect(settings.activeRuntimeEnvironmentId).toBeNull()
    expect(stored.compactWorktreeCards).toBe(true)
    expect(stored).not.toHaveProperty('activeRuntimeEnvironmentId')
    expect(runtimeCalls).toEqual([
      { method: 'settings.update', params: { compactWorktreeCards: true } }
    ])
  }, 15_000)

  it('forwards new worktree card style updates to a paired runtime', async () => {
    const runtimeCalls: { method: string; params: unknown }[] = []
    vi.doMock('./web-runtime-client', () => ({
      WebRuntimeClient: class {
        call(method: string, params?: unknown): Promise<RuntimeRpcResponse<unknown>> {
          runtimeCalls.push({ method, params })
          return Promise.resolve({
            id: `call-${runtimeCalls.length}`,
            ok: true,
            result: { settings: { experimentalNewWorktreeCardStyle: true } },
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

    const settings = await globals.window.api.settings.set({
      experimentalNewWorktreeCardStyle: true
    })

    expect(settings.experimentalNewWorktreeCardStyle).toBe(true)
    expect(runtimeCalls).toEqual([
      { method: 'settings.update', params: { experimentalNewWorktreeCardStyle: true } }
    ])
  })

  it('forwards MiniMax usage setting updates to a paired runtime', async () => {
    const runtimeCalls: { method: string; params: unknown }[] = []
    vi.doMock('./web-runtime-client', () => ({
      WebRuntimeClient: class {
        call(method: string, params?: unknown): Promise<RuntimeRpcResponse<unknown>> {
          runtimeCalls.push({ method, params })
          return Promise.resolve({
            id: `call-${runtimeCalls.length}`,
            ok: true,
            result: {
              settings: {
                minimaxGroupId: 'group-42',
                minimaxUsageModels: 'general,abab6.5'
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
    const { installWebPreloadApi } = await import('./web-preload-api')
    installWebPreloadApi()

    const settings = await globals.window.api.settings.set({
      minimaxGroupId: 'group-42',
      minimaxUsageModels: 'general,abab6.5'
    })

    const stored = JSON.parse(globals.storage.getItem('orca.web.settings.v1') ?? '{}') as {
      minimaxGroupId?: string
      minimaxUsageModels?: string
    }

    expect(settings.minimaxGroupId).toBe('group-42')
    expect(settings.minimaxUsageModels).toBe('general,abab6.5')
    expect(stored.minimaxGroupId).toBe('group-42')
    expect(stored.minimaxUsageModels).toBe('general,abab6.5')
    expect(runtimeCalls).toEqual([
      {
        method: 'settings.update',
        params: {
          minimaxGroupId: 'group-42',
          minimaxUsageModels: 'general,abab6.5'
        }
      }
    ])
  })

  it('forwards normalized bot-author overrides to a paired runtime', async () => {
    const runtimeCalls: { method: string; params: unknown }[] = []
    vi.doMock('./web-runtime-client', () => ({
      WebRuntimeClient: class {
        call(method: string, params?: unknown): Promise<RuntimeRpcResponse<unknown>> {
          runtimeCalls.push({ method, params })
          return Promise.resolve({
            id: 'call-1',
            ok: true,
            result: { settings: { prBotAuthorOverrides: ['gretelflux'] } },
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

    const settings = await globals.window.api.settings.set({
      prBotAuthorOverrides: [' GretelFlux ', 'gretelflux']
    })

    expect(settings.prBotAuthorOverrides).toEqual(['gretelflux'])
    expect(runtimeCalls).toEqual([
      { method: 'settings.update', params: { prBotAuthorOverrides: ['gretelflux'] } }
    ])
  })

  it('atomically updates a bot-author override through a paired runtime', async () => {
    const runtimeCalls: { method: string; params: unknown }[] = []
    vi.doMock('./web-runtime-client', () => ({
      WebRuntimeClient: class {
        call(method: string, params?: unknown): Promise<RuntimeRpcResponse<unknown>> {
          runtimeCalls.push({ method, params })
          return Promise.resolve({
            id: 'call-1',
            ok: true,
            result: { settings: { prBotAuthorOverrides: ['gretelflux'] } },
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

    const settings = await globals.window.api.settings.updatePRBotAuthorOverride({
      author: 'gretelflux',
      isBot: true
    })

    expect(settings.prBotAuthorOverrides).toEqual(['gretelflux'])
    expect(runtimeCalls).toEqual([
      {
        method: 'settings.updatePRBotAuthorOverride',
        params: { author: 'gretelflux', isBot: true }
      }
    ])
  })

  it('does not claim a paired bot-author update succeeded when the runtime rejects it', async () => {
    vi.doMock('./web-runtime-client', () => ({
      WebRuntimeClient: class {
        call(): Promise<RuntimeRpcResponse<unknown>> {
          return Promise.reject(new Error('runtime unavailable'))
        }

        close(): void {}
      }
    }))

    const globals = installBrowserGlobals('Linux')
    writeStoredRuntimeEnvironment(globals.storage)
    const { installWebPreloadApi } = await import('./web-preload-api')
    installWebPreloadApi()

    await expect(
      globals.window.api.settings.updatePRBotAuthorOverride({
        author: 'gretelflux',
        isBot: true
      })
    ).rejects.toThrow('runtime unavailable')

    const stored = JSON.parse(globals.storage.getItem('orca.web.settings.v1') ?? '{}') as {
      prBotAuthorOverrides?: string[]
    }
    expect(stored.prBotAuthorOverrides).toBeUndefined()
  })
})
