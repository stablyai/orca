// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { listRuntimePlugins } from '@/runtime/runtime-plugin-client'
import {
  subscribeRemotePlugins,
  useRemotePluginPanelsStore,
  setRemotePluginPanelHealth
} from './remote-plugin-panels'
import type { PluginHostListEntry } from '../../../preload/api-types'
vi.mock('@/runtime/runtime-plugin-client', () => ({
  listRuntimePlugins: vi.fn(),
  pluginRuntimeOwner: vi.fn()
}))
vi.mock('@/store', () => ({ useAppStore: vi.fn() }))
const cleanups: (() => void)[] = []
function subscribe(id: string): () => void {
  const dispose = subscribeRemotePlugins(id)
  cleanups.push(dispose)
  return dispose
}
afterEach(() => {
  cleanups.splice(0).forEach((dispose) => dispose())
  vi.resetAllMocks()
  vi.useRealTimers()
})
const row: PluginHostListEntry = {
  pluginKey: 'sample.board',
  name: 'Board',
  version: '1',
  publisher: 'sample',
  status: 'idle',
  consentFingerprint: null,
  needsReconsent: false,
  isDev: false,
  official: false,
  bundled: false,
  capabilities: [],
  panels: [],
  commands: [],
  hasWorker: true,
  restarts: 0
}
describe('remote plugin catalog lifecycle', () => {
  it('shares one poll between consumers and drops stale capabilities on failure', async () => {
    vi.useFakeTimers()
    vi.mocked(listRuntimePlugins)
      .mockResolvedValueOnce([row])
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue([])
    subscribe('a')
    subscribe('a')
    await vi.advanceTimersByTimeAsync(0)
    expect(listRuntimePlugins).toHaveBeenCalledTimes(1)
    expect(useRemotePluginPanelsStore.getState().catalogs.a.plugins).toEqual([row])
    await vi.advanceTimersByTimeAsync(10_000)
    expect(useRemotePluginPanelsStore.getState().catalogs.a).toEqual({
      plugins: [],
      fetchStatus: 'error',
      panelErrors: {}
    })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(useRemotePluginPanelsStore.getState().catalogs.a.fetchStatus).toBe('ready')
  })
  it('ignores a late reply after its last consumer leaves, including a new subscription to the same host', async () => {
    let resolveOld: (rows: PluginHostListEntry[]) => void = () => {}
    vi.mocked(listRuntimePlugins)
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveOld = resolve
        })
      )
      .mockResolvedValue([])
    const stop = subscribe('a')
    stop()
    cleanups.splice(0)
    subscribe('a')
    await Promise.resolve()
    resolveOld([row])
    await Promise.resolve()
    expect(useRemotePluginPanelsStore.getState().catalogs.a.plugins).toEqual([])
  })
  it('isolates identical plugin IDs on different hosts', async () => {
    vi.mocked(listRuntimePlugins).mockImplementation(async (id) => [{ ...row, name: id }])
    subscribe('a')
    subscribe('b')
    await Promise.resolve()
    expect(useRemotePluginPanelsStore.getState().catalogs.a.plugins[0].name).toBe('a')
    expect(useRemotePluginPanelsStore.getState().catalogs.b.plugins[0].name).toBe('b')
  })
})

it('keeps panel health separate for identical IDs on different hosts', async () => {
  vi.mocked(listRuntimePlugins).mockResolvedValue([row])
  subscribe('a')
  subscribe('b')
  await Promise.resolve()
  setRemotePluginPanelHealth('a', 'plugin:sample.board/main', 'error')
  expect(useRemotePluginPanelsStore.getState().catalogs.a.panelErrors).toEqual({
    'plugin:sample.board/main': true
  })
  expect(useRemotePluginPanelsStore.getState().catalogs.b.panelErrors).toEqual({})
})
