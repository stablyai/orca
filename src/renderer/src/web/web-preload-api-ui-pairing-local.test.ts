import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  PAIRING_LOCAL_UI_FIELDS,
  type PairingLocalUiField
} from '../../../shared/pairing-local-ui-fields'
import type { PersistedUIState } from '../../../shared/persisted-ui-state-types'
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import type { ManualRepoOrderEntry } from '../../../shared/ui-chrome-types'
import {
  installBrowserGlobals,
  writeStoredRuntimeEnvironment
} from './web-preload-api-test-harness'

// Both directions of the web pairing seam: a host value must never overwrite the browser's own
// copy of a pairing-local field, and the browser's must never be sent to the host.
describe('web UI preload API pairing-local fields', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.doUnmock('./web-runtime-client')
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
    workspaceHostOrder: ['runtime:web-env-1', 'local'],
    agentsVisibleHostIds: ['runtime:web-env-1'],
    agentsFilterRepoIds: ['repo-b'],
    agentsShowChildAgents: true,
    agentsCompactMode: false,
    agentsShowSearch: false,
    agentsReadFilter: 'unread',
    agentsGroupBy: 'project',
    activityClearedAtByPaneKey: { 'tab-1:leaf-1': 123 },
    manuallyUnreadTurnsByPaneKey: { 'tab-1:leaf-1': 321 },
    defaultBrowserSessionProfileIdByHostId: {
      local: '11111111-1111-1111-1111-111111111111'
    }
  }
  const hostUiSamples: Record<PairingLocalUiField, unknown> = {
    automationHostFilter: { kind: 'all' },
    hideWorkspacesFromOtherDevices: false,
    manualRepoOrder: [{ hostId: 'local', repoId: 'repo-a' }],
    workspaceHostOrder: ['local', 'ssh:box'],
    agentsVisibleHostIds: ['local'],
    agentsFilterRepoIds: ['repo-a'],
    agentsShowChildAgents: false,
    agentsCompactMode: true,
    agentsShowSearch: true,
    agentsReadFilter: 'all',
    agentsGroupBy: 'status',
    activityClearedAtByPaneKey: { 'tab-2:leaf-2': 456 },
    manuallyUnreadTurnsByPaneKey: { 'tab-2:leaf-2': 654 },
    defaultBrowserSessionProfileIdByHostId: {
      local: '22222222-2222-2222-2222-222222222222'
    }
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
})
