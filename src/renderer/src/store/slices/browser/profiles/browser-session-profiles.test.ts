import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { getDefaultBrowserProfileForHost } from '../hosts/browser-host-state'
import {
  createBrowserMockApi,
  createTestStore,
  resetBrowserRuntimeMocks
} from '../browser-slice-test-harness'

const createWebRuntimeSessionBrowserTabMock = vi.hoisted(() => vi.fn())
const runtimeEnvironmentCall = vi.fn()
const runtimeEnvironmentTransportCall = vi.fn()

vi.mock('@/runtime/browser/creation/web-runtime-browser-creation', () => ({
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
