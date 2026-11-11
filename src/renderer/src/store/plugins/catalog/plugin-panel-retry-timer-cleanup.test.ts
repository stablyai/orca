import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { PluginHostListEntry } from '../../../../../shared/plugins/plugin-list-entry'
import type { PluginChangeEvent } from '../../../../../shared/plugins/events/plugin-change-event'
import type { usePluginPanelsStore } from './plugin-contribution-catalog'

type List = () => Promise<PluginHostListEntry[]>
type PanelStore = typeof usePluginPanelsStore

function plugin(): PluginHostListEntry {
  return {
    pluginKey: 'samples.current',
    consentFingerprint: 'test',
    name: 'Current',
    version: '1',
    publisher: 'test',
    status: 'idle',
    needsReconsent: false,
    isDev: false,
    official: false,
    bundled: false,
    capabilities: [],
    panels: [],
    commands: [],
    hasWorker: false,
    restarts: 0
  }
}

function view(store: PanelStore) {
  const { plugins, panelErrors, fetchStatus } = store.getState()
  return { plugins, panelErrors, fetchStatus }
}

async function harness(list: List) {
  let changed: ((event: PluginChangeEvent) => void) | undefined
  const onChanged = vi.fn((callback: (event: PluginChangeEvent) => void) => {
    changed = callback
    return vi.fn()
  })
  vi.stubGlobal('window', { api: { plugins: { list, onChanged } } })
  const { usePluginPanelsStore: store, ensurePluginPanelsLoaded: ensure } =
    await import('./plugin-contribution-catalog')
  return { store, ensure, onChanged, change: () => changed?.({ contentPacksChanged: false }) }
}

beforeEach(() => {
  vi.resetModules()
  vi.useFakeTimers()
  vi.setSystemTime(0)
})

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

it('keeps an authoritative replacement made reentrantly during loading above the older failure', async () => {
  const gate = Promise.withResolvers<PluginHostListEntry[]>()
  const rows = [plugin()]
  const list = vi
    .fn<List>()
    .mockRejectedValueOnce(new Error('starting'))
    .mockReturnValueOnce(gate.promise)
  const { store } = await harness(list)
  await store.getState().fetchPlugins()
  const unsubscribe = store.subscribe((state) => {
    if (state.fetchStatus === 'loading') {
      store.getState().setPlugins(rows)
    }
  })
  const pending = store.getState().fetchPlugins()
  const failure = new Error('old request failed')
  gate.reject(failure)
  await expect(pending).resolves.toBeUndefined()
  await expect(list.mock.results[1]?.value).rejects.toBe(failure)
  await vi.advanceTimersByTimeAsync(500)
  expect(list).toHaveBeenCalledTimes(2)
  expect(store.getState().plugins).toBe(rows)
  expect(view(store)).toEqual({ plugins: rows, panelErrors: {}, fetchStatus: 'ready' })
  expect(vi.getTimerCount()).toBe(0)
  unsubscribe()
})

it('retains the latest reentrant fetch and ignores the superseded request result', async () => {
  const gate = Promise.withResolvers<PluginHostListEntry[]>()
  const rows = [plugin()]
  const list = vi
    .fn<List>()
    .mockRejectedValueOnce(new Error('starting'))
    .mockResolvedValueOnce(rows)
    .mockReturnValueOnce(gate.promise)
  const { store } = await harness(list)
  await store.getState().fetchPlugins()
  let entered = false
  let latest: Promise<void> | undefined
  const unsubscribe = store.subscribe((state) => {
    if (!entered && state.fetchStatus === 'loading') {
      entered = true
      latest = store.getState().fetchPlugins()
    }
  })
  const old = store.getState().fetchPlugins()
  await latest
  const timers = vi.getTimerCount()
  gate.reject(new Error('superseded'))
  await expect(old).resolves.toBeUndefined()
  await vi.advanceTimersByTimeAsync(500)
  expect(list).toHaveBeenCalledTimes(3)
  expect(store.getState().plugins).toBe(rows)
  expect(view(store)).toEqual({ plugins: rows, panelErrors: {}, fetchStatus: 'ready' })
  unsubscribe()
  expect(timers).toBe(0)
})
