import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '../types'
import { getExecutionHostLabel } from '../../../../shared/execution-host'
import {
  createBrowserMockApi,
  createTestStore,
  resetBrowserRuntimeMocks,
  settingsWithRuntime
} from './browser-slice-test-harness'

const createWebRuntimeSessionBrowserTabMock = vi.hoisted(() => vi.fn())
const runtimeEnvironmentCall = vi.fn()
const runtimeEnvironmentTransportCall = vi.fn()

vi.mock('@/runtime/web-runtime-session', () => ({
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

  it('forwards profile UA options to the active runtime environment', async () => {
    const store = createTestStore()
    const profile = {
      id: 'remote-google',
      scope: 'isolated' as const,
      partition: 'persist:remote-google',
      label: 'Google',
      source: null,
      userAgentMode: 'native' as const
    }
    runtimeEnvironmentCall.mockResolvedValueOnce({
      id: 'rpc-create',
      ok: true,
      result: { profile },
      _meta: { runtimeId: 'runtime-remote' }
    })
    store.setState({ settings: settingsWithRuntime('env-1') })

    await expect(
      store
        .getState()
        .createBrowserSessionProfile('isolated', 'Google', { userAgentMode: 'native' })
    ).resolves.toEqual(profile)
    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'browser.profileCreate',
      params: { scope: 'isolated', label: 'Google', userAgentMode: 'native' },
      timeoutMs: 15_000
    })
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
      executionHostLabel: getExecutionHostLabel('local')
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

  it('forwards profile UA options to local browser IPC', async () => {
    const store = createTestStore()
    const profile = {
      id: 'local-google',
      scope: 'isolated' as const,
      partition: 'persist:local-google',
      label: 'Google',
      source: null,
      userAgentMode: 'native' as const
    }
    mockApi.browser.sessionCreateProfile.mockResolvedValueOnce(profile)

    await expect(
      store
        .getState()
        .createBrowserSessionProfile('isolated', 'Google', { userAgentMode: 'native' })
    ).resolves.toEqual(profile)
    expect(mockApi.browser.sessionCreateProfile).toHaveBeenCalledWith({
      scope: 'isolated',
      label: 'Google',
      userAgentMode: 'native'
    })
  })
})
