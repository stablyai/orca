import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '../../../types'
import type { BrowserCookieImportSummary } from '../../../../../../shared/browser-workspace-types'
import { getDefaultBrowserProfileForHost } from '../hosts/browser-host-state'
import {
  createBrowserMockApi,
  createTestStore,
  resetBrowserRuntimeMocks,
  settingsWithRuntime
} from '../browser-slice-test-harness'

const createWebRuntimeSessionBrowserTabMock = vi.hoisted(() => vi.fn())
const runtimeEnvironmentCall = vi.fn()
const runtimeEnvironmentTransportCall = vi.fn()

vi.mock('@/runtime/web-runtime-browser-creation', () => ({
  createWebRuntimeSessionBrowserTab: createWebRuntimeSessionBrowserTabMock
}))

const mockApi = createBrowserMockApi(runtimeEnvironmentTransportCall)

// @ts-expect-error test window mock
globalThis.window = { api: mockApi }

describe('createBrowserSlice runtime guard', () => {
  beforeEach(() => {
    resetBrowserRuntimeMocks({
      runtimeEnvironmentCall,
      runtimeEnvironmentTransportCall,
      createWebRuntimeSessionBrowserTabMock
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('keeps the default profile pick when a server profile fetch fails', async () => {
    const store = createTestStore()
    runtimeEnvironmentCall.mockRejectedValueOnce(new Error('timed out'))
    store.setState({
      settings: {
        ...settingsWithRuntime('env-1')!,
        browserDefaultProfileIdByHostId: { 'runtime:env-1': 'work' }
      }
    })

    await store.getState().fetchBrowserSessionProfiles()

    expect(getDefaultBrowserProfileForHost(store.getState(), 'runtime:env-1')).toBe('work')
  })

  it('keeps browser profile lists separate per host', async () => {
    const store = createTestStore()
    runtimeEnvironmentCall.mockResolvedValueOnce({
      id: 'rpc-remote',
      ok: true,
      result: {
        profiles: [
          {
            id: 'remote-default',
            scope: 'default',
            partition: 'persist:orca-remote',
            label: 'Remote Default',
            source: null
          }
        ]
      },
      _meta: { runtimeId: 'runtime-remote' }
    })
    store.setState({ settings: settingsWithRuntime('env-1') })

    await store.getState().fetchBrowserSessionProfiles()

    mockApi.browser.sessionListProfiles.mockResolvedValueOnce([
      {
        id: 'local-default',
        scope: 'default',
        partition: 'persist:orca-local',
        label: 'Local Default',
        source: null
      }
    ])
    store.setState({ settings: { activeRuntimeEnvironmentId: null } as AppState['settings'] })

    await store.getState().fetchBrowserSessionProfiles()

    expect(store.getState().browserSessionProfilesByHostId['runtime:env-1']?.[0]?.id).toBe(
      'remote-default'
    )
    expect(store.getState().browserSessionProfilesByHostId.local?.[0]?.id).toBe('local-default')
    expect(store.getState().browserSessionProfiles[0]?.id).toBe('local-default')
  })

  it.each(['local IPC', 'client-hosted IPC', 'remote RPC'] as const)(
    'preserves the cookie import execution owner from %s through the store',
    async (route) => {
      const summary: BrowserCookieImportSummary = {
        totalCookies: 5,
        importedCookies: 0,
        skippedCookies: 5,
        domains: [],
        warning: {
          code: 'cookies-undecryptable',
          reason: 'linux-keyring-unavailable',
          failedCookies: 3,
          otherFailedCookies: 2,
          keyringFailure: { cause: 'secret-tool-missing', browser: 'Google Chrome' }
        }
      }
      const importResult = { ok: true as const, profileId: 'default', summary }
      const store = createTestStore()
      if (route === 'local IPC') {
        mockApi.browser.sessionImportFromBrowser.mockResolvedValueOnce(importResult)
      } else {
        store.setState({ settings: settingsWithRuntime('env-1') })
        mockApi.browser.sessionImportFromBrowserForClientHost.mockResolvedValueOnce(
          route === 'client-hosted IPC' ? importResult : null
        )
        if (route === 'remote RPC') {
          runtimeEnvironmentCall.mockResolvedValueOnce({
            id: 'rpc-import',
            ok: true,
            result: importResult,
            _meta: { runtimeId: 'runtime-1' }
          })
        }
      }

      const result = await store.getState().importCookiesFromBrowser('default', 'chrome', 'Default')

      expect(result.ok).toBe(true)
      if (!result.ok) {
        throw new Error(result.reason)
      }
      expect(result.summary).toEqual(summary)
      expect(store.getState().browserSessionImportState).toEqual({
        profileId: 'default',
        status: 'success',
        summary,
        error: null
      })
      expect(result).toMatchObject({
        executionHostId: route === 'local IPC' ? 'local' : 'runtime:env-1',
        executionMachine: route === 'remote RPC' ? 'remote' : 'client',
        executionRemoteEnvironment: route !== 'local IPC'
      })
    }
  )

  it('drops the default profile pick once a refreshed list no longer has it', async () => {
    const store = createTestStore()
    const listed = (id: string) => ({
      id,
      scope: id === 'default' ? ('default' as const) : ('isolated' as const),
      partition: `persist:${id}`,
      label: id,
      source: null
    })
    await store.getState().setDefaultBrowserSessionProfileId('work')
    expect(store.getState().settings?.browserDefaultProfileIdByHostId).toEqual({ local: 'work' })
    mockApi.browser.sessionListProfiles
      .mockResolvedValueOnce([listed('default'), listed('work')])
      .mockResolvedValueOnce([listed('default')])

    await store.getState().fetchBrowserSessionProfiles('local')
    expect(getDefaultBrowserProfileForHost(store.getState(), 'local')).toBe('work')

    await store.getState().fetchBrowserSessionProfiles('local')
    expect(getDefaultBrowserProfileForHost(store.getState(), 'local')).toBeNull()
  })

  it('keeps the newest listing when an older one answers last', async () => {
    const store = createTestStore()
    const listed = (id: string) => ({
      id,
      scope: id === 'default' ? ('default' as const) : ('isolated' as const),
      partition: `persist:${id}`,
      label: id,
      source: null
    })
    const older = Promise.withResolvers<ReturnType<typeof listed>[]>()
    mockApi.browser.sessionListProfiles
      .mockReturnValueOnce(older.promise)
      .mockResolvedValueOnce([listed('default')])

    const olderFetch = store.getState().fetchBrowserSessionProfiles('local')
    await store.getState().fetchBrowserSessionProfiles('local')
    older.resolve([listed('default'), listed('deleted')])
    await olderFetch

    expect(store.getState().browserSessionProfilesByHostId.local).toEqual([listed('default')])
  })
})
