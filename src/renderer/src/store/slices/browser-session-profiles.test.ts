import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '../types'
import type { BrowserCookieImportSummary } from '../../../../shared/browser-workspace-types'
import { getExecutionHostLabel } from '../../../../shared/execution-host'
import { emitBrowserCookieImportToast } from '@/lib/browser-cookie-import-toast'
import { getDefaultBrowserProfileForHost } from './browser/browser-host-state'
import {
  createBrowserMockApi,
  createTestStore,
  resetBrowserRuntimeMocks,
  settingsWithRuntime
} from './browser-slice-test-harness'

const createWebRuntimeSessionBrowserTabMock = vi.hoisted(() => vi.fn())
const { successToastMock, warningToastMock } = vi.hoisted(() => ({
  successToastMock: vi.fn(),
  warningToastMock: vi.fn()
}))
const runtimeEnvironmentCall = vi.fn()
const runtimeEnvironmentTransportCall = vi.fn()

vi.mock('sonner', () => ({
  toast: { success: successToastMock, warning: warningToastMock }
}))

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

  it('fetches browser profiles from the active runtime environment', async () => {
    const store = createTestStore()
    runtimeEnvironmentCall.mockResolvedValueOnce({
      id: 'rpc-1',
      ok: true,
      result: {
        profiles: [
          {
            id: 'default',
            scope: 'default',
            partition: 'persist:orca-default',
            label: 'Default',
            source: null
          }
        ]
      },
      _meta: { runtimeId: 'runtime-remote' }
    })
    store.setState({
      settings: settingsWithRuntime('env-1'),
      browserSessionProfiles: []
    })

    await store.getState().fetchBrowserSessionProfiles()

    expect(mockApi.browser.sessionListProfiles).not.toHaveBeenCalled()
    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'browser.profileList',
      params: undefined,
      timeoutMs: 15_000
    })
    expect(store.getState().browserSessionProfiles).toEqual([
      {
        id: 'default',
        scope: 'default',
        partition: 'persist:orca-default',
        label: 'Default',
        source: null
      }
    ])
    expect(store.getState().browserSessionProfilesByHostId['runtime:env-1']).toEqual([
      {
        id: 'default',
        scope: 'default',
        partition: 'persist:orca-default',
        label: 'Default',
        source: null
      }
    ])
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

  it('creates a profile in the active runtime environment', async () => {
    const store = createTestStore()
    const profile = {
      id: 'remote-google',
      scope: 'isolated' as const,
      partition: 'persist:remote-google',
      label: 'Google',
      source: null
    }
    runtimeEnvironmentCall.mockResolvedValueOnce({
      id: 'rpc-create',
      ok: true,
      result: { profile },
      _meta: { runtimeId: 'runtime-remote' }
    })
    store.setState({ settings: settingsWithRuntime('env-1') })

    await expect(
      store.getState().createBrowserSessionProfile('isolated', 'Google')
    ).resolves.toEqual(profile)
    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'browser.profileCreate',
      params: { scope: 'isolated', label: 'Google' },
      timeoutMs: 15_000
    })
  })

  it("loads this computer's profiles on request while a server is selected", async () => {
    const store = createTestStore()
    mockApi.browser.sessionListProfiles.mockResolvedValueOnce([
      { id: 'work', scope: 'isolated', partition: 'persist:work', label: 'Work', source: null }
    ])
    store.setState({ settings: settingsWithRuntime('env-1'), browserSessionProfiles: [] })

    await store.getState().fetchBrowserSessionProfiles('local')

    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
    expect(store.getState().browserSessionProfilesByHostId.local?.[0]?.id).toBe('work')
    // The server's list, which Browser settings is showing, stays as it was.
    expect(store.getState().browserSessionProfiles).toEqual([])
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

  it('imports a cookie file through this desktop when it hosts the runtime pages', async () => {
    mockApi.browser.sessionImportCookiesForClientHost.mockResolvedValueOnce({
      ok: true,
      profileId: 'default',
      summary: { totalCookies: 1, importedCookies: 1, skippedCookies: 0, domains: [] }
    })
    const store = createTestStore()
    store.setState({ settings: settingsWithRuntime('env-1') })

    const result = await store.getState().importCookiesToProfile('default')

    expect(mockApi.browser.sessionImportCookiesForClientHost).toHaveBeenCalledWith({
      environmentId: 'env-1',
      profileId: 'default'
    })
    expect(mockApi.browser.sessionImportCookies).not.toHaveBeenCalled()
    expect(result).toMatchObject({ ok: true, executionHostId: 'runtime:env-1' })
  })

  it('does not import local browser cookies while a runtime environment is active', async () => {
    const store = createTestStore()
    store.setState({ settings: settingsWithRuntime('env-1') })

    const result = await store.getState().importCookiesToProfile('default')

    expect(mockApi.browser.sessionImportCookies).not.toHaveBeenCalled()
    expect(result).toMatchObject({
      ok: false,
      executionHostId: 'runtime:env-1',
      executionHostLabel: 'env-1'
    })
    expect(store.getState().browserSessionImportState).toMatchObject({
      profileId: 'default',
      status: 'error'
    })
  })

  it('retains the host display label used by browser settings', async () => {
    const store = createTestStore()
    store.setState({
      settings: {
        ...settingsWithRuntime('env-1')!,
        hostSettingOverrides: {
          'runtime:env-1': { displayLabel: 'Production Browser Host' }
        }
      },
      runtimeEnvironments: [{ id: 'env-1', name: 'Remote Mac' }] as never
    })

    const result = await store.getState().importCookiesToProfile('default')

    expect(result.executionHostLabel).toBe('Production Browser Host')
  })

  it('retains the local execution host for a successful browser import', async () => {
    mockApi.browser.sessionImportFromBrowser.mockResolvedValueOnce({
      ok: true,
      profileId: 'default',
      summary: { totalCookies: 2, importedCookies: 2, skippedCookies: 0, domains: [] }
    })
    const store = createTestStore()

    const result = await store.getState().importCookiesFromBrowser('default', 'chrome', 'Default')

    expect(result).toMatchObject({
      ok: true,
      executionHostId: 'local',
      executionHostLabel: getExecutionHostLabel('local'),
      executionMachine: 'client',
      executionRemoteEnvironment: false
    })
  })

  it.each(['local IPC', 'client-hosted IPC', 'remote RPC'] as const)(
    'preserves the missing-tool summary from %s through the store to the warning toast',
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
      expect(mockApi.browser.sessionImportFromBrowser).toHaveBeenCalledTimes(
        route === 'local IPC' ? 1 : 0
      )
      expect(mockApi.browser.sessionImportFromBrowserForClientHost).toHaveBeenCalledTimes(
        route === 'local IPC' ? 0 : 1
      )
      const rpcImportCalls = runtimeEnvironmentCall.mock.calls.filter(
        ([request]) => request.method === 'browser.profileImportFromBrowser'
      )
      expect(rpcImportCalls).toHaveLength(route === 'remote RPC' ? 1 : 0)

      emitBrowserCookieImportToast(result.summary, 'Imported 0 cookies.', result)

      expect(warningToastMock).toHaveBeenCalledTimes(1)
      expect(warningToastMock).toHaveBeenCalledWith(
        "Orca couldn't read 3 of Google Chrome's encrypted cookies because secret-tool isn't installed. Install libsecret-tools (or your distribution's equivalent) and import again. 2 more cookies could not be decrypted for another reason."
      )
      expect(successToastMock).not.toHaveBeenCalled()
    }
  )

  // Offer browsers on the machine import reads: headless remotes otherwise produce empty or wrong-host choices.
  it('lists this desktop’s browsers when the environment’s pages are client-hosted', async () => {
    const store = createTestStore()
    store.setState({ settings: settingsWithRuntime('env-1') })
    mockApi.browser.sessionDetectBrowsersForClientHost.mockResolvedValueOnce([
      { family: 'chrome', label: 'Google Chrome', profiles: [], selectedProfile: 'Default' }
    ])

    await store.getState().fetchDetectedBrowsers()

    expect(mockApi.browser.sessionDetectBrowsersForClientHost).toHaveBeenCalledWith({
      environmentId: 'env-1'
    })
    expect(runtimeEnvironmentCall).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: 'browser.profileDetectBrowsers' })
    )
    expect(store.getState().detectedBrowsers).toEqual([
      { family: 'chrome', label: 'Google Chrome', profiles: [], selectedProfile: 'Default' }
    ])
    expect(store.getState().detectedBrowsersHost).toEqual({ machine: 'client', hostLabel: 'env-1' })
  })

  it('falls back to the server-side detection when the desktop hosts no pages', async () => {
    const store = createTestStore()
    store.setState({ settings: settingsWithRuntime('env-1') })
    runtimeEnvironmentCall.mockResolvedValueOnce({
      id: 'rpc-detect',
      ok: true,
      result: {
        browsers: [
          { family: 'chrome', label: 'Google Chrome', profiles: [], selectedProfile: 'Profile 3' }
        ]
      },
      _meta: { runtimeId: 'runtime-1' }
    })

    await store.getState().fetchDetectedBrowsers()

    expect(mockApi.browser.sessionDetectBrowsersForClientHost).toHaveBeenCalled()
    expect(store.getState().detectedBrowsers).toEqual([
      { family: 'chrome', label: 'Google Chrome', profiles: [], selectedProfile: 'Profile 3' }
    ])
    expect(store.getState().detectedBrowsersHost).toEqual({ machine: 'remote', hostLabel: 'env-1' })
  })

  it('imports client-hosted logins on this desktop instead of the headless server', async () => {
    const store = createTestStore()
    store.setState({ settings: settingsWithRuntime('env-1') })
    mockApi.browser.sessionImportFromBrowserForClientHost.mockResolvedValueOnce({
      ok: true,
      profileId: 'default',
      summary: { totalCookies: 3, importedCookies: 3, skippedCookies: 0, domains: [] }
    })

    const result = await store.getState().importCookiesFromBrowser('default', 'chrome', 'Default')

    expect(mockApi.browser.sessionImportFromBrowserForClientHost).toHaveBeenCalledWith({
      environmentId: 'env-1',
      profileId: 'default',
      browserFamily: 'chrome',
      browserProfile: 'Default'
    })
    expect(runtimeEnvironmentCall).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: 'browser.profileImportFromBrowser' })
    )
    expect(result).toMatchObject({
      ok: true,
      executionHostId: 'runtime:env-1',
      executionMachine: 'client',
      executionRemoteEnvironment: true
    })
  })

  it('falls back to the server-side import when the desktop hosts no pages', async () => {
    const store = createTestStore()
    store.setState({ settings: settingsWithRuntime('env-1') })
    runtimeEnvironmentCall.mockResolvedValueOnce({
      id: 'rpc-import',
      ok: true,
      result: {
        ok: true,
        profileId: 'default',
        summary: { totalCookies: 1, importedCookies: 1, skippedCookies: 0, domains: [] }
      },
      _meta: { runtimeId: 'runtime-1' }
    })

    const result = await store.getState().importCookiesFromBrowser('default', 'chrome', 'Default')

    expect(mockApi.browser.sessionImportFromBrowserForClientHost).toHaveBeenCalled()
    expect(result).toMatchObject({
      ok: true,
      executionMachine: 'remote',
      executionRemoteEnvironment: true
    })
  })

  it('uses local browser IPC when no runtime environment is active', async () => {
    const store = createTestStore()
    mockApi.browser.sessionListProfiles.mockResolvedValueOnce([
      {
        id: 'default',
        scope: 'default',
        partition: 'persist:orca-default',
        label: 'Default',
        source: null
      }
    ])

    await store.getState().fetchBrowserSessionProfiles()

    expect(mockApi.browser.sessionListProfiles).toHaveBeenCalledTimes(1)
    expect(store.getState().browserSessionProfiles).toEqual([
      {
        id: 'default',
        scope: 'default',
        partition: 'persist:orca-default',
        label: 'Default',
        source: null
      }
    ])
  })

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

  it('drops the default profile pick when that profile is deleted', async () => {
    const store = createTestStore()
    await store.getState().setDefaultBrowserSessionProfileId('work')
    mockApi.browser.sessionDeleteProfile.mockResolvedValueOnce(true)

    await store.getState().deleteBrowserSessionProfile('work')

    expect(store.getState().settings?.browserDefaultProfileIdByHostId).toEqual({})
  })

  it("keeps both hosts' picks when the second is made before the first is saved", async () => {
    const store = createTestStore()
    const acks: (() => void)[] = []
    store.setState({
      updateSettings: (updates) =>
        new Promise<void>((resolve) =>
          acks.push(() => {
            store.setState((s) => ({ settings: { ...s.settings!, ...updates } }))
            resolve()
          })
        )
    })
    const local = store.getState().setDefaultBrowserSessionProfileId('work')
    store.setState({ browserSessionHostIdOverride: 'runtime:env-1' })
    const remote = store.getState().setDefaultBrowserSessionProfileId('remote-work')
    const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
    await flush()
    acks.shift()?.()
    await flush()
    acks.shift()?.()
    await Promise.all([local, remote])

    expect(store.getState().settings?.browserDefaultProfileIdByHostId).toEqual({
      local: 'work',
      'runtime:env-1': 'remote-work'
    })
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

  it('creates a profile through local browser IPC', async () => {
    const store = createTestStore()
    const profile = {
      id: 'local-google',
      scope: 'isolated' as const,
      partition: 'persist:local-google',
      label: 'Google',
      source: null
    }
    mockApi.browser.sessionCreateProfile.mockResolvedValueOnce(profile)

    await expect(
      store.getState().createBrowserSessionProfile('isolated', 'Google')
    ).resolves.toEqual(profile)
    expect(mockApi.browser.sessionCreateProfile).toHaveBeenCalledWith({
      scope: 'isolated',
      label: 'Google'
    })
  })
})
