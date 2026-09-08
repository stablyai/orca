import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeEnvironmentCallRequest } from '../../runtime/runtime-compatibility-test-fixture'
import {
  createBrowserMockApi,
  createTestStore,
  resetBrowserRuntimeMocks
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

  it('routes browser settings per client without changing the durable Active Server', async () => {
    runtimeEnvironmentCall.mockImplementation((request: RuntimeEnvironmentCallRequest) => {
      const { selector, method } = request as RuntimeEnvironmentCallRequest & { selector: string }
      return Promise.resolve({
        id: `${selector}-${method}`,
        ok: true,
        result:
          method === 'browser.profileList'
            ? {
                profiles: [
                  {
                    id: `${selector}-default`,
                    scope: 'default',
                    partition: `persist:${selector}`,
                    label: `${selector} Default`,
                    source: null
                  }
                ]
              }
            : { browsers: [] },
        _meta: { runtimeId: `runtime-${selector}` }
      })
    })
    const firstClient = createTestStore()
    const secondClient = createTestStore()

    void firstClient.getState().setBrowserSessionHostId('runtime:windows-2')
    void secondClient.getState().setBrowserSessionHostId('runtime:linux-3')

    await vi.waitFor(() => {
      expect(firstClient.getState().browserSessionProfiles[0]?.id).toBe('windows-2-default')
      expect(secondClient.getState().browserSessionProfiles[0]?.id).toBe('linux-3-default')
    })
    expect(firstClient.getState().settings?.activeRuntimeEnvironmentId).toBeNull()
    expect(secondClient.getState().settings?.activeRuntimeEnvironmentId).toBeNull()

    const restartedClient = createTestStore()
    expect(restartedClient.getState().browserSessionHostIdOverride).toBeNull()
    expect(restartedClient.getState().settings?.activeRuntimeEnvironmentId).toBeNull()
  })

  it('does not let a slower server response overwrite the newly selected host', async () => {
    let resolveWindowsProfiles: ((value: unknown) => void) | undefined
    runtimeEnvironmentCall.mockImplementation((request: RuntimeEnvironmentCallRequest) => {
      const { selector, method } = request as RuntimeEnvironmentCallRequest & {
        selector: string
      }
      if (method !== 'browser.profileList') {
        return Promise.resolve({
          id: `${selector}-${method}`,
          ok: true,
          result: { browsers: [] },
          _meta: { runtimeId: `runtime-${selector}` }
        })
      }
      if (selector === 'windows-2') {
        return new Promise((resolve) => {
          resolveWindowsProfiles = resolve
        })
      }
      return Promise.resolve({
        id: 'linux-profiles',
        ok: true,
        result: {
          profiles: [
            {
              id: 'linux-default',
              scope: 'default',
              partition: 'persist:linux',
              label: 'Linux Default',
              source: null
            }
          ]
        },
        _meta: { runtimeId: 'runtime-linux' }
      })
    })
    const store = createTestStore()

    void store.getState().setBrowserSessionHostId('runtime:windows-2')
    void store.getState().setBrowserSessionHostId('runtime:linux-3')
    await vi.waitFor(() =>
      expect(store.getState().browserSessionProfiles[0]?.id).toBe('linux-default')
    )
    resolveWindowsProfiles?.({
      id: 'windows-profiles',
      ok: true,
      result: {
        profiles: [
          {
            id: 'windows-default',
            scope: 'default',
            partition: 'persist:windows',
            label: 'Windows Default',
            source: null
          }
        ]
      },
      _meta: { runtimeId: 'runtime-windows' }
    })
    await vi.waitFor(() =>
      expect(store.getState().browserSessionProfilesByHostId['runtime:windows-2']?.[0]?.id).toBe(
        'windows-default'
      )
    )

    expect(store.getState().browserSessionHostIdOverride).toBe('runtime:linux-3')
    expect(store.getState().browserSessionProfiles[0]?.id).toBe('linux-default')
    expect(store.getState().settings?.activeRuntimeEnvironmentId).toBeNull()
  })

  it('does not let an import completion refresh or overwrite a newly selected host', async () => {
    let resolveImport: ((value: unknown) => void) | undefined
    runtimeEnvironmentCall.mockImplementation((request: RuntimeEnvironmentCallRequest) => {
      const { selector, method } = request as RuntimeEnvironmentCallRequest & { selector: string }
      if (selector === 'windows-2' && method === 'browser.profileImportFromBrowser') {
        return new Promise((resolve) => {
          resolveImport = resolve
        })
      }
      return Promise.resolve({
        id: `${selector}-${method}`,
        ok: true,
        result: method === 'browser.profileList' ? { profiles: [] } : { browsers: [] },
        _meta: { runtimeId: `runtime-${selector}` }
      })
    })
    const store = createTestStore()
    store.setState({
      browserSessionHostIdOverride: 'runtime:windows-2',
      runtimeEnvironments: [{ id: 'windows-2', name: 'Windows Server' }] as never
    })

    const importing = store
      .getState()
      .importCookiesFromBrowser('windows-profile', 'chrome', 'Default')
    await vi.waitFor(() => expect(resolveImport).toBeDefined())
    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'windows-2',
      method: 'browser.profileImportFromBrowser',
      params: {
        profileId: 'windows-profile',
        browserFamily: 'chrome',
        browserProfile: 'Default',
        supportsPartitionSkippedCookies: true
      },
      timeoutMs: 30_000
    })
    await store.getState().setBrowserSessionHostId('runtime:linux-3')
    const callsBeforeCompletion = runtimeEnvironmentCall.mock.calls.length
    resolveImport?.({
      id: 'windows-import',
      ok: true,
      result: {
        ok: true,
        profileId: 'windows-profile',
        summary: { totalCookies: 2, importedCookies: 2, skippedCookies: 0, domains: [] }
      },
      _meta: { runtimeId: 'runtime-windows' }
    })

    await expect(importing).resolves.toMatchObject({
      ok: true,
      profileId: 'windows-profile',
      executionHostId: 'runtime:windows-2',
      executionHostLabel: 'Windows Server'
    })
    expect(store.getState().browserSessionHostIdOverride).toBe('runtime:linux-3')
    expect(store.getState().browserSessionImportState).toBeNull()
    expect(runtimeEnvironmentCall.mock.calls).toHaveLength(callsBeforeCompletion)
  })
})
