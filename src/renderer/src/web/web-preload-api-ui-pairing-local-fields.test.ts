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

describe('web UI preload API pairing-local fields', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.doUnmock('./web-runtime-client')
  })

  // Different host samples expose any missing browser-local pin.
  const browserLocalUiSamples: Record<PairingLocalUiField, unknown> = {
    automationHostFilter: { kind: 'host', hostKey: 'browser-local-host-key' },
    hideWorkspacesFromOtherDevices: true,
    manualRepoOrder: [{ hostId: 'runtime:web-env-1', repoId: 'repo-b' }],
    workspaceHostOrder: ['runtime:web-env-1', 'local'],
    sidebarOpen: false,
    agentsVisibleHostIds: ['runtime:web-env-1'],
    agentsFilterRepoIds: ['repo-b'],
    agentsHideWorkspacesFromOtherDevices: true,
    agentsHideAutomationGeneratedWorkspaces: true,
    agentsHideCliCreatedWorkspaces: true,
    agentsShowChildAgents: true,
    agentsCompactMode: false,
    agentsShowSearch: false,
    agentsReadFilter: 'unread',
    agentsGroupBy: 'project',
    activityClearedAtByPaneKey: { 'tab-1:leaf-1': 123 },
    manuallyUnreadTurnsByPaneKey: { 'tab-1:leaf-1': 321 }
  }
  const hostUiSamples: Record<PairingLocalUiField, unknown> = {
    automationHostFilter: { kind: 'all' },
    hideWorkspacesFromOtherDevices: false,
    manualRepoOrder: [{ hostId: 'local', repoId: 'repo-a' }],
    workspaceHostOrder: ['local', 'ssh:box'],
    sidebarOpen: true,
    agentsVisibleHostIds: ['local'],
    agentsFilterRepoIds: ['repo-a'],
    agentsHideWorkspacesFromOtherDevices: false,
    agentsHideAutomationGeneratedWorkspaces: false,
    agentsHideCliCreatedWorkspaces: false,
    agentsShowChildAgents: false,
    agentsCompactMode: true,
    agentsShowSearch: true,
    agentsReadFilter: 'all',
    agentsGroupBy: 'status',
    activityClearedAtByPaneKey: { 'tab-2:leaf-2': 456 },
    manuallyUnreadTurnsByPaneKey: { 'tab-2:leaf-2': 654 }
  }

  it.each(
    PAIRING_LOCAL_UI_FIELDS.flatMap((field) =>
      (['set', 'setWithAck'] as const).map((method) => [field, method] as const)
    )
  )(
    'keeps the browser-local %s and never sends it to the host through %s',
    async (field, method) => {
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

      const browserLocal: Partial<PersistedUIState> = { [field]: browserLocalUiSamples[field] }
      const globals = installBrowserGlobals('Linux')
      writeStoredRuntimeEnvironment(globals.storage)
      const { installWebPreloadApi } = await import('./web-preload-api')
      installWebPreloadApi()

      const write = globals.window.api.ui[method]
      expect(write).toBeTypeOf('function')
      if (!write) {
        throw new Error('Missing UI write method')
      }
      await write({ ...browserLocal, sidebarWidth: 280 })

      expect(runtimeCalls[0]).toEqual({ method: 'ui.set', params: { sidebarWidth: 280 } })
      await expect(globals.window.api.ui.get()).resolves.toMatchObject(browserLocal)
      expect(JSON.parse(globals.storage.getItem('orca.web.ui.v1') ?? '{}')).toMatchObject(
        browserLocal
      )
    }
  )
})
