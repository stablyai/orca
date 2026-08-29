import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FeatureInteractionState } from '../../../shared/feature-interactions'
import {
  PAIRING_LOCAL_UI_FIELDS,
  type PairingLocalUiField
} from '../../../shared/pairing-local-ui-fields'
import type { PersistedUIState } from '../../../shared/persisted-ui-state-types'
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import type { ManualRepoOrderEntry } from '../../../shared/ui-chrome-types'
import {
  installApi,
  installBrowserGlobals,
  writeStoredRuntimeEnvironment
} from './web-preload-api-test-harness'

describe('web before-unload persistence', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.doUnmock('./web-runtime-client')
  })

  it('persists final UI and host-partitioned sessions synchronously', async () => {
    const { api, storage } = await installApi('Linux')

    api.app.stageBeforeUnloadSync({
      sessions: [
        { state: { activeWorktreeId: 'local-worktree' } as never },
        {
          state: { activeWorktreeId: 'remote-worktree' } as never,
          hostId: 'runtime:web-env-1'
        }
      ],
      ui: { activeView: 'settings' }
    })

    expect(JSON.parse(storage.getItem('orca.web.workspaceSession.v1') ?? '{}')).toMatchObject({
      activeWorktreeId: 'local-worktree'
    })
    expect(
      JSON.parse(storage.getItem('orca.web.workspaceSession.v1.runtime:web-env-1') ?? '{}')
    ).toMatchObject({ activeWorktreeId: 'remote-worktree' })
    expect(JSON.parse(storage.getItem('orca.web.ui.v1') ?? '{}')).toMatchObject({
      activeView: 'settings'
    })
  })
})

describe('web UI preload API', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.doUnmock('./web-runtime-client')
  })

  it('keeps native-only keyboard probes conservative', async () => {
    const { api } = await installApi('Macintosh')

    await expect(api.app.getMacCapturedDigitRowChords()).resolves.toEqual([])
    await expect(api.app.getKeyboardLayoutSnapshot()).resolves.toBeNull()
    const listener = vi.fn()
    expect(api.app.onKeyboardLayoutChanged(listener)).toEqual(expect.any(Function))
    expect(listener).not.toHaveBeenCalled()
  })

  it('migrates missing right sidebar visibility from the effective web legacy default', async () => {
    const { api } = await installApi('Linux')

    const ui = await api.ui.get()

    expect(ui.rightSidebarOpen).toBe(false)
  })

  it('keeps explicit local right sidebar visibility over the legacy default', async () => {
    const { api, storage } = await installApi('Linux')
    storage.setItem('orca.web.ui.v1', JSON.stringify({ rightSidebarOpen: true }))

    const ui = await api.ui.get()

    expect(ui.rightSidebarOpen).toBe(true)
  })

  it('seeds missing local card display properties from runtime-backed compact settings when ui.get is unavailable', async () => {
    const runtimeCalls: { method: string; params: unknown }[] = []
    vi.doMock('./web-runtime-client', () => ({
      WebRuntimeClient: class {
        call(method: string, params?: unknown): Promise<RuntimeRpcResponse<unknown>> {
          runtimeCalls.push({ method, params })
          if (method === 'settings.get') {
            return Promise.resolve({
              id: `call-${runtimeCalls.length}`,
              ok: true,
              result: { settings: { compactWorktreeCards: true } },
              _meta: { runtimeId: 'runtime-1' }
            })
          }
          return Promise.resolve({
            id: `call-${runtimeCalls.length}`,
            ok: false,
            error: { code: 'method_not_found', message: 'Unknown method' },
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

    await globals.window.api.settings.get()
    const ui = await globals.window.api.ui.get()

    expect(ui.worktreeCardProperties).toEqual(['status', 'unread'])
    expect(ui.worktreeCardProperties).not.toContain('ports')
    expect(ui.worktreeCardProperties).not.toContain('inline-agents')
    expect(runtimeCalls.map((call) => call.method)).toEqual(['settings.get', 'ui.get'])
  })

  it('preserves explicit local card display properties when compact fallback settings are present', async () => {
    const runtimeCalls: { method: string; params: unknown }[] = []
    vi.doMock('./web-runtime-client', () => ({
      WebRuntimeClient: class {
        call(method: string, params?: unknown): Promise<RuntimeRpcResponse<unknown>> {
          runtimeCalls.push({ method, params })
          if (method === 'settings.get') {
            return Promise.resolve({
              id: `call-${runtimeCalls.length}`,
              ok: true,
              result: { settings: { compactWorktreeCards: true } },
              _meta: { runtimeId: 'runtime-1' }
            })
          }
          return Promise.resolve({
            id: `call-${runtimeCalls.length}`,
            ok: false,
            error: { code: 'method_not_found', message: 'Unknown method' },
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
      JSON.stringify({ worktreeCardProperties: ['status', 'pr'] })
    )
    const { installWebPreloadApi } = await import('./web-preload-api')
    installWebPreloadApi()

    await globals.window.api.settings.get()
    const ui = await globals.window.api.ui.get()

    expect(ui.worktreeCardProperties).toEqual(['status', 'unread', 'pr'])
    expect(ui.worktreeCardProperties).not.toContain('ports')
    expect(ui.worktreeCardProperties).not.toContain('inline-agents')
    expect(runtimeCalls.map((call) => call.method)).toEqual(['settings.get', 'ui.get'])
  })

  it('keeps newer feature interaction counts when runtime responses resolve out of order', async () => {
    const pending: ((response: RuntimeRpcResponse<unknown>) => void)[] = []
    vi.doMock('./web-runtime-client', () => ({
      WebRuntimeClient: class {
        call(method: string): Promise<RuntimeRpcResponse<unknown>> {
          return new Promise((resolve) => {
            pending.push((response) =>
              resolve({
                ...response,
                id: method,
                _meta: { runtimeId: 'runtime-1' }
              })
            )
          })
        }

        close(): void {}
      }
    }))

    const globals = installBrowserGlobals('Linux')
    writeStoredRuntimeEnvironment(globals.storage)
    const { installWebPreloadApi } = await import('./web-preload-api')
    installWebPreloadApi()

    const first = globals.window.api.ui.recordFeatureInteraction('tasks')
    const second = globals.window.api.ui.recordFeatureInteraction('tasks')

    pending[1]({
      id: 'second',
      ok: true,
      result: {
        ui: {
          featureInteractions: {
            tasks: { firstInteractedAt: 100, interactionCount: 2 }
          }
        }
      },
      _meta: { runtimeId: 'runtime-1' }
    })
    await second
    pending[0]({
      id: 'first',
      ok: true,
      result: {
        ui: {
          featureInteractions: {
            tasks: { firstInteractedAt: 100, interactionCount: 1 }
          }
        }
      },
      _meta: { runtimeId: 'runtime-1' }
    })
    await first

    const stored = JSON.parse(globals.storage.getItem('orca.web.ui.v1') ?? '{}') as {
      featureInteractions?: FeatureInteractionState
    }
    expect(stored.featureInteractions?.tasks).toEqual({
      firstInteractedAt: 100,
      interactionCount: 2
    })
  })

  it('keeps newer local feature interactions when ui.get returns stale host state', async () => {
    vi.doMock('./web-runtime-client', () => ({
      WebRuntimeClient: class {
        call(method: string): Promise<RuntimeRpcResponse<unknown>> {
          return Promise.resolve({
            id: method,
            ok: true,
            result: {
              ui: {
                featureInteractions: {
                  tasks: { firstInteractedAt: 100, interactionCount: 1 },
                  ports: { firstInteractedAt: 300, interactionCount: 1 }
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
      'orca.web.ui.v1',
      JSON.stringify({
        featureInteractions: {
          tasks: { firstInteractedAt: 50, interactionCount: 3 }
        }
      })
    )
    const { installWebPreloadApi } = await import('./web-preload-api')
    installWebPreloadApi()

    const ui = await globals.window.api.ui.get()
    const stored = JSON.parse(globals.storage.getItem('orca.web.ui.v1') ?? '{}') as {
      featureInteractions?: FeatureInteractionState
    }

    expect(ui.featureInteractions?.tasks).toEqual({
      firstInteractedAt: 50,
      interactionCount: 3
    })
    expect(stored.featureInteractions?.tasks).toEqual({
      firstInteractedAt: 50,
      interactionCount: 3
    })
    expect(stored.featureInteractions?.ports).toEqual({
      firstInteractedAt: 300,
      interactionCount: 1
    })
  })

  it('keeps the workspace origin filter browser-local across host UI responses', async () => {
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
                hideWorkspacesFromOtherDevices: false,
                featureInteractions: {
                  tasks: { firstInteractedAt: 100, interactionCount: 1 }
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
    const { installWebPreloadApi } = await import('./web-preload-api')
    installWebPreloadApi()

    await globals.window.api.ui.set({ hideWorkspacesFromOtherDevices: true })
    expect(runtimeCalls[0]).toEqual({ method: 'ui.set', params: {} })
    await expect(globals.window.api.ui.get()).resolves.toMatchObject({
      hideWorkspacesFromOtherDevices: true
    })
    await expect(globals.window.api.ui.recordFeatureInteraction('tasks')).resolves.toMatchObject({
      hideWorkspacesFromOtherDevices: true
    })
    expect(JSON.parse(globals.storage.getItem('orca.web.ui.v1') ?? '{}')).toMatchObject({
      hideWorkspacesFromOtherDevices: true
    })
  })

  it('keeps the manual repo order browser-local instead of overwriting the host order', async () => {
    const runtimeCalls: { method: string; params: unknown }[] = []
    vi.doMock('./web-runtime-client', () => ({
      WebRuntimeClient: class {
        call(method: string, params?: unknown): Promise<RuntimeRpcResponse<unknown>> {
          runtimeCalls.push({ method, params })
          return Promise.resolve({
            id: method,
            ok: true,
            result: { ui: {} },
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

    // The web client keys its order to its own runtime:web-* host, so a host that predates the
    // RPC-side strip would persist it over the desktop's local/ssh-keyed order.
    const manualRepoOrder: ManualRepoOrderEntry[] = [
      { hostId: 'runtime:web-11111111-2222-3333-4444-555555555555', repoId: 'repo-b' },
      { hostId: 'runtime:web-11111111-2222-3333-4444-555555555555', repoId: 'repo-a' }
    ]
    await globals.window.api.ui.set({ manualRepoOrder, sidebarWidth: 280 })

    expect(runtimeCalls[0]).toEqual({ method: 'ui.set', params: { sidebarWidth: 280 } })
    expect(JSON.parse(globals.storage.getItem('orca.web.ui.v1') ?? '{}')).toMatchObject({
      manualRepoOrder,
      sidebarWidth: 280
    })
  })

  // Why cover a host that still sends the field: clients and hosts update independently, so a new
  // web client meets hosts predating the response omission. On a profile an old web client
  // poisoned, those echoed runtime:web-* entries match this browser's own repos and would beat
  // every drag it has made since.
  it.each([
    [
      'this browser own stale runtime:web-* entries',
      [
        { hostId: 'runtime:web-env-1', repoId: 'repo-c' },
        { hostId: 'runtime:web-env-1', repoId: 'repo-a' }
      ]
    ],
    [
      'the desktop local/ssh-keyed order',
      [
        { hostId: 'local', repoId: 'repo-a' },
        { hostId: 'ssh:box', repoId: 'repo-b' }
      ]
    ],
    ['an empty overlay from a desktop that never dragged', []]
  ])('keeps the browser-local manual repo order when ui.get returns %s', async (_label, hosted) => {
    vi.doMock('./web-runtime-client', () => ({
      WebRuntimeClient: class {
        call(method: string): Promise<RuntimeRpcResponse<unknown>> {
          return Promise.resolve({
            id: method,
            ok: true,
            result: { ui: { manualRepoOrder: hosted } },
            _meta: { runtimeId: 'runtime-1' }
          })
        }

        close(): void {}
      }
    }))

    const webOwnOrder: ManualRepoOrderEntry[] = [
      { hostId: 'runtime:web-env-1', repoId: 'repo-b' },
      { hostId: 'runtime:web-env-1', repoId: 'repo-a' }
    ]
    const globals = installBrowserGlobals('Linux')
    writeStoredRuntimeEnvironment(globals.storage)
    globals.storage.setItem('orca.web.ui.v1', JSON.stringify({ manualRepoOrder: webOwnOrder }))
    const { installWebPreloadApi } = await import('./web-preload-api')
    installWebPreloadApi()

    await expect(globals.window.api.ui.get()).resolves.toMatchObject({
      manualRepoOrder: webOwnOrder
    })
    expect(JSON.parse(globals.storage.getItem('orca.web.ui.v1') ?? '{}')).toMatchObject({
      manualRepoOrder: webOwnOrder
    })
  })

  it('keeps the browser-local manual repo order when a new host omits it entirely', async () => {
    vi.doMock('./web-runtime-client', () => ({
      WebRuntimeClient: class {
        call(method: string): Promise<RuntimeRpcResponse<unknown>> {
          return Promise.resolve({
            id: method,
            ok: true,
            result: { ui: { sidebarWidth: 320 } },
            _meta: { runtimeId: 'runtime-1' }
          })
        }

        close(): void {}
      }
    }))

    const webOwnOrder: ManualRepoOrderEntry[] = [
      { hostId: 'runtime:web-env-1', repoId: 'repo-b' },
      { hostId: 'runtime:web-env-1', repoId: 'repo-a' }
    ]
    const globals = installBrowserGlobals('Linux')
    writeStoredRuntimeEnvironment(globals.storage)
    globals.storage.setItem('orca.web.ui.v1', JSON.stringify({ manualRepoOrder: webOwnOrder }))
    const { installWebPreloadApi } = await import('./web-preload-api')
    installWebPreloadApi()

    await expect(globals.window.api.ui.get()).resolves.toMatchObject({
      manualRepoOrder: webOwnOrder,
      sidebarWidth: 320
    })
  })

  // Census-driven, matching the host-side seam tests: a field added to PAIRING_LOCAL_UI_FIELDS
  // without wiring the web read seam fails here rather than shipping. The host sample differs from
  // the browser's for every field, so only the pin makes this pass.
  const browserLocalUiSamples: Record<PairingLocalUiField, unknown> = {
    automationHostFilter: { kind: 'host', hostKey: 'browser-local-host-key' },
    hideWorkspacesFromOtherDevices: true,
    manualRepoOrder: [{ hostId: 'runtime:web-env-1', repoId: 'repo-b' }],
    workspaceHostOrder: ['runtime:web-env-1', 'local']
  }
  const hostUiSamples: Record<PairingLocalUiField, unknown> = {
    automationHostFilter: { kind: 'all' },
    hideWorkspacesFromOtherDevices: false,
    manualRepoOrder: [{ hostId: 'local', repoId: 'repo-a' }],
    workspaceHostOrder: ['local', 'ssh:box']
  }

  it.each(PAIRING_LOCAL_UI_FIELDS.map((field) => [field] as const))(
    'keeps the browser-local %s and never sends it to the host',
    async (field) => {
      const runtimeCalls: { method: string; params: unknown }[] = []
      vi.doMock('./web-runtime-client', () => ({
        WebRuntimeClient: class {
          call(method: string, params?: unknown): Promise<RuntimeRpcResponse<unknown>> {
            runtimeCalls.push({ method, params })
            return Promise.resolve({
              id: method,
              ok: true,
              result: { ui: { [field]: hostUiSamples[field] } },
              _meta: { runtimeId: 'runtime-1' }
            })
          }

          close(): void {}
        }
      }))

      const browserLocal = { [field]: browserLocalUiSamples[field] } as Partial<PersistedUIState>
      const globals = installBrowserGlobals('Linux')
      writeStoredRuntimeEnvironment(globals.storage)
      globals.storage.setItem('orca.web.ui.v1', JSON.stringify(browserLocal))
      const { installWebPreloadApi } = await import('./web-preload-api')
      installWebPreloadApi()

      await globals.window.api.ui.set({ ...browserLocal, sidebarWidth: 280 })

      expect(runtimeCalls[0]).toEqual({ method: 'ui.set', params: { sidebarWidth: 280 } })
      await expect(globals.window.api.ui.get()).resolves.toMatchObject(browserLocal)
      expect(JSON.parse(globals.storage.getItem('orca.web.ui.v1') ?? '{}')).toMatchObject(
        browserLocal
      )
    }
  )

  it('union-merges local contextual tour seen ids when ui.get returns stale host state', async () => {
    vi.doMock('./web-runtime-client', () => ({
      WebRuntimeClient: class {
        call(method: string): Promise<RuntimeRpcResponse<unknown>> {
          return Promise.resolve({
            id: method,
            ok: true,
            result: {
              ui: {
                contextualToursSeenIds: ['browser', 'unknown']
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
      'orca.web.ui.v1',
      JSON.stringify({
        contextualToursSeenIds: ['tasks', 'browser']
      })
    )
    const { installWebPreloadApi } = await import('./web-preload-api')
    installWebPreloadApi()

    const ui = await globals.window.api.ui.get()
    const stored = JSON.parse(globals.storage.getItem('orca.web.ui.v1') ?? '{}') as {
      contextualToursSeenIds?: string[]
    }

    expect(ui.contextualToursSeenIds).toEqual(['tasks', 'browser'])
    expect(stored.contextualToursSeenIds).toEqual(['tasks', 'browser'])
  })

  it('keeps the local OSC 52 notice armed when ui.get returns an unmigrated host', async () => {
    vi.doMock('./web-runtime-client', () => ({
      WebRuntimeClient: class {
        call(method: string): Promise<RuntimeRpcResponse<unknown>> {
          return Promise.resolve({
            id: method,
            ok: true,
            // Why false: the host store always projects this key, so a plain spread
            // would overwrite the arm the web client's own settings migration raised.
            result: { ui: { osc52ClipboardDefaultOnNoticePending: false } },
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
      JSON.stringify({ osc52ClipboardDefaultOnNoticePending: true })
    )
    const { installWebPreloadApi } = await import('./web-preload-api')
    installWebPreloadApi()

    const ui = await globals.window.api.ui.get()
    expect(ui.osc52ClipboardDefaultOnNoticePending).toBe(true)

    await globals.window.api.ui.set({ osc52ClipboardDefaultOnNoticePending: false })
    const cleared = await globals.window.api.ui.get()
    expect(cleared.osc52ClipboardDefaultOnNoticePending).toBe(false)
  })

  it('keeps the local OSC 52 notice armed when recordFeatureInteraction returns an unmigrated host', async () => {
    vi.doMock('./web-runtime-client', () => ({
      WebRuntimeClient: class {
        call(method: string): Promise<RuntimeRpcResponse<unknown>> {
          return Promise.resolve({
            id: method,
            ok: true,
            result: { ui: { osc52ClipboardDefaultOnNoticePending: false } },
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
      JSON.stringify({ osc52ClipboardDefaultOnNoticePending: true })
    )
    const { installWebPreloadApi } = await import('./web-preload-api')
    installWebPreloadApi()

    const ui = await globals.window.api.ui.recordFeatureInteraction('tasks')
    expect(ui.osc52ClipboardDefaultOnNoticePending).toBe(true)
  })

  it('does not keep a local shadow copy of main-owned feature telemetry markers', async () => {
    vi.doMock('./web-runtime-client', () => ({
      WebRuntimeClient: class {
        call(method: string): Promise<RuntimeRpcResponse<unknown>> {
          return Promise.resolve({
            id: method,
            ok: true,
            result: { ui: {} },
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
      JSON.stringify({
        featureInteractionTelemetryBuckets: { tasks: 'count_1000_plus' }
      })
    )
    const { installWebPreloadApi } = await import('./web-preload-api')
    installWebPreloadApi()

    await globals.window.api.ui.set({
      featureInteractionTelemetryBuckets: { tasks: 'count_500_999' }
    } as never)
    const ui = await globals.window.api.ui.get()
    const stored = JSON.parse(globals.storage.getItem('orca.web.ui.v1') ?? '{}') as Record<
      string,
      unknown
    >

    expect('featureInteractionTelemetryBuckets' in (ui as Record<string, unknown>)).toBe(false)
    expect(stored.featureInteractionTelemetryBuckets).toBeUndefined()
  })

  it('union-merges local contextual tour seen ids when recordFeatureInteraction returns stale host state', async () => {
    vi.doMock('./web-runtime-client', () => ({
      WebRuntimeClient: class {
        call(method: string): Promise<RuntimeRpcResponse<unknown>> {
          return Promise.resolve({
            id: method,
            ok: true,
            result: {
              ui: {
                contextualToursSeenIds: ['browser']
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
      'orca.web.ui.v1',
      JSON.stringify({
        contextualToursSeenIds: ['tasks']
      })
    )
    const { installWebPreloadApi } = await import('./web-preload-api')
    installWebPreloadApi()

    const ui = await globals.window.api.ui.recordFeatureInteraction('tasks')
    const stored = JSON.parse(globals.storage.getItem('orca.web.ui.v1') ?? '{}') as {
      contextualToursSeenIds?: string[]
    }

    expect(ui.contextualToursSeenIds).toEqual(['tasks', 'browser'])
    expect(stored.contextualToursSeenIds).toEqual(['tasks', 'browser'])
  })

  it('proxies host skill discovery and computer-use permission APIs for paired web clients', async () => {
    const calls: { method: string; params: unknown }[] = []
    vi.doMock('./web-runtime-client', () => ({
      WebRuntimeClient: class {
        call(method: string, params: unknown): Promise<RuntimeRpcResponse<unknown>> {
          calls.push({ method, params })
          if (method === 'skills.discover') {
            return Promise.resolve({
              id: method,
              ok: true,
              result: {
                skills: [
                  {
                    id: 'home:computer-use',
                    name: 'computer-use',
                    description: null,
                    providers: ['agent-skills'],
                    sourceKind: 'home',
                    sourceLabel: 'Home',
                    rootPath: '/skills',
                    directoryPath: '/skills/computer-use',
                    skillFilePath: '/skills/computer-use/SKILL.md',
                    installed: true,
                    updatedAt: null
                  }
                ],
                sources: [],
                scannedAt: 123
              },
              _meta: { runtimeId: 'runtime-1' }
            })
          }
          if (method === 'computer.permissionsStatus') {
            return Promise.resolve({
              id: method,
              ok: true,
              result: {
                platform: 'darwin',
                helperAppPath: '/Applications/Orca Computer Use.app',
                helperUnavailableReason: null,
                permissions: [
                  { id: 'accessibility', status: 'granted' },
                  { id: 'screenshots', status: 'granted' }
                ]
              },
              _meta: { runtimeId: 'runtime-1' }
            })
          }
          if (method === 'computer.permissions') {
            return Promise.resolve({
              id: method,
              ok: true,
              result: {
                platform: 'darwin',
                helperAppPath: '/Applications/Orca Computer Use.app',
                permissionId:
                  params && typeof params === 'object' ? (params as { id?: string }).id : undefined,
                openedSettings: true,
                launchedHelper: true,
                nextStep: null
              },
              _meta: { runtimeId: 'runtime-1' }
            })
          }
          return Promise.resolve({
            id: method,
            ok: true,
            result: {},
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

    await expect(
      globals.window.api.skills.discover({ cwd: '/repo/worktree' })
    ).resolves.toMatchObject({
      skills: [{ name: 'computer-use', installed: true }],
      scannedAt: 123
    })
    const permissionsStatus = await globals.window.api.computerUsePermissions.getStatus()
    expect(permissionsStatus.helperUnavailableReason).toBeNull()
    expect(permissionsStatus.permissions).toContainEqual({ id: 'accessibility', status: 'granted' })
    await expect(
      globals.window.api.computerUsePermissions.openSetup({ id: 'accessibility' })
    ).resolves.toMatchObject({
      openedSettings: true,
      launchedHelper: true,
      permissionId: 'accessibility'
    })
    expect(calls).toEqual(
      expect.arrayContaining([
        { method: 'skills.discover', params: { cwd: '/repo/worktree' } },
        { method: 'computer.permissionsStatus', params: {} },
        { method: 'computer.permissions', params: { id: 'accessibility' } }
      ])
    )
  })

  it('setWithAck rejects on transport failure while set stays best-effort (STA-5781)', async () => {
    vi.doMock('./web-runtime-client', () => ({
      WebRuntimeClient: class {
        call(method: string): Promise<RuntimeRpcResponse<unknown>> {
          if (method === 'ui.set') {
            return Promise.reject(new Error('runtime disconnected'))
          }
          return Promise.resolve({
            id: method,
            ok: true,
            result: {},
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

    // Plain set swallows the failure so fire-and-forget callers stay quiet...
    await expect(
      globals.window.api.ui.set({ hideDefaultBranchWorkspace: true })
    ).resolves.toBeUndefined()
    // ...but the diff writer's ack path must see it, or it folds a patch the
    // host never received into its baseline and silently stops retrying it.
    await expect(
      globals.window.api.ui.setWithAck!({ hideSleepingWorkspaces: true })
    ).rejects.toThrow('runtime disconnected')
  })

  it('rejects paired web skill discovery failures instead of returning an empty scan', async () => {
    vi.doMock('./web-runtime-client', () => ({
      WebRuntimeClient: class {
        call(method: string): Promise<RuntimeRpcResponse<unknown>> {
          if (method === 'skills.discover') {
            return Promise.reject(new Error('runtime disconnected'))
          }
          return Promise.resolve({
            id: method,
            ok: true,
            result: {},
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

    await expect(globals.window.api.skills.discover({ cwd: '/repo' })).rejects.toThrow(
      'runtime disconnected'
    )
  })

  it('rejects paired web computer-use status failures instead of marking the helper unavailable', async () => {
    vi.doMock('./web-runtime-client', () => ({
      WebRuntimeClient: class {
        call(method: string): Promise<RuntimeRpcResponse<unknown>> {
          if (method === 'computer.permissionsStatus') {
            return Promise.reject(new Error('runtime disconnected'))
          }
          return Promise.resolve({
            id: method,
            ok: true,
            result: {},
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

    await expect(globals.window.api.computerUsePermissions.getStatus()).rejects.toThrow(
      'runtime disconnected'
    )
  })
})
