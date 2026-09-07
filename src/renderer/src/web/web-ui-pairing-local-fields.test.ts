import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  PAIRING_LOCAL_UI_FIELDS,
  type PairingLocalUiField
} from '../../../shared/pairing-local-ui-fields'
import type { PersistedUIState } from '../../../shared/persisted-ui-state-types'
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import {
  installBrowserGlobals,
  writeStoredRuntimeEnvironment
} from './web-preload-api-test-harness'

describe('web UI pairing-local fields', () => {
  beforeEach(() => vi.resetModules())
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.doUnmock('./web-runtime-client')
  })
  // Census-driven, matching the host-side seam tests: a field added to PAIRING_LOCAL_UI_FIELDS
  // without wiring the web read seam fails here rather than shipping. The host sample differs from
  // the browser's for every field, so only the pin makes this pass.
  const browserLocalUiSamples: Record<PairingLocalUiField, unknown> = {
    windowPaneLayout: {
      version: 1,
      root: { type: 'leaf', groupId: 'pane' },
      activePaneId: 'pane',
      expandedPaneId: null,
      panes: { pane: { id: 'pane', viewIds: [], selectedViewId: null } },
      views: {}
    },
    automationHostFilter: { kind: 'host', hostKey: 'browser-local-host-key' },
    hideWorkspacesFromOtherDevices: true,
    manualRepoOrder: [{ hostId: 'runtime:web-env-1', repoId: 'repo-b' }],
    workspaceHostOrder: ['runtime:web-env-1', 'local'],
    agentsVisibleHostIds: ['runtime:web-env-1'],
    agentsFilterRepoIds: ['repo-b'],
    agentsShowChildAgents: true,
    agentsCompactMode: false,
    agentsReadFilter: 'unread',
    agentsGroupBy: 'project',
    activityClearedAtByPaneKey: { 'tab-1:leaf-1': 123 },
    manuallyUnreadTurnsByPaneKey: { 'tab-1:leaf-1': 321 },
    workspaceWindowIds: ['browser-window'],
    workspaceWindowPlacements: {
      'browser-window': { bounds: { x: 10, y: 20, width: 900, height: 700 }, maximized: false }
    }
  }
  const hostUiSamples: Record<PairingLocalUiField, unknown> = {
    windowPaneLayout: null,
    automationHostFilter: { kind: 'all' },
    hideWorkspacesFromOtherDevices: false,
    manualRepoOrder: [{ hostId: 'local', repoId: 'repo-a' }],
    workspaceHostOrder: ['local', 'ssh:box'],
    agentsVisibleHostIds: ['local'],
    agentsFilterRepoIds: ['repo-a'],
    agentsShowChildAgents: false,
    agentsCompactMode: true,
    agentsReadFilter: 'all',
    agentsGroupBy: 'status',
    activityClearedAtByPaneKey: { 'tab-2:leaf-2': 456 },
    manuallyUnreadTurnsByPaneKey: { 'tab-2:leaf-2': 654 },
    workspaceWindowIds: ['host-window'],
    workspaceWindowPlacements: {
      'host-window': { bounds: { x: 30, y: 40, width: 1000, height: 800 }, maximized: true }
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
