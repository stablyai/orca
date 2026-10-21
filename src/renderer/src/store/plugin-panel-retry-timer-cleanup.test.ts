import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { PluginHostListEntry } from '../../../preload/api-types'
import type { PluginChangeEvent } from '../../../shared/plugins/plugin-change-event'
import type { usePluginPanelsStore } from './plugin-panels'

type List = () => Promise<PluginHostListEntry[]>
type PanelStore = typeof usePluginPanelsStore

function plugin(): PluginHostListEntry {
  return {
    pluginKey: 'orca-samples.current',
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
    await import('./plugin-panels')
  return { store, ensure, onChanged, change: () => changed?.({ contentPacksChanged: false }) }
}

const empty = (fetchStatus: 'loading' | 'error' | 'ready') => ({
  plugins: [],
  panelErrors: {},
  fetchStatus
})

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

it('retires superseded change-event retries and preserves every refresh/state update', async () => {
  const failure = new Error('transport unavailable')
  const list = vi.fn<List>().mockRejectedValue(failure)
  const { store, ensure, change, onChanged } = await harness(list)
  const history: ReturnType<typeof view>[] = []
  const unsubscribe = store.subscribe(() => history.push(view(store)))
  ensure()
  await Promise.resolve()
  for (let index = 1; index < 64; index++) {
    change()
    await Promise.resolve()
  }
  const pendingBeforeReplacement = vi.getTimerCount()
  store.getState().setPlugins([])
  const pendingAfterReplacement = vi.getTimerCount()
  await vi.advanceTimersByTimeAsync(500)
  expect(list).toHaveBeenCalledTimes(64)
  await expect(list.mock.results[0]?.value).rejects.toBe(failure)
  expect(onChanged).toHaveBeenCalledOnce()
  expect(history).toEqual([
    ...Array.from({ length: 64 }, () => [empty('loading'), empty('error')]).flat(),
    empty('ready')
  ])
  expect(view(store)).toEqual(empty('ready'))
  expect(vi.getTimerCount()).toBe(0)
  unsubscribe()
  expect([pendingBeforeReplacement, pendingAfterReplacement]).toEqual([1, 0])
})

it('retires a failed-owner timer while a replacement IPC stays pending without cancelling it', async () => {
  const gate = Promise.withResolvers<PluginHostListEntry[]>()
  const list = vi
    .fn<List>()
    .mockRejectedValueOnce(new Error('starting'))
    .mockReturnValueOnce(gate.promise)
  const { store } = await harness(list)
  await store.getState().fetchPlugins()
  const pending = store.getState().fetchPlugins()
  let settled = false
  void pending.then(() => {
    settled = true
  })
  const timers = vi.getTimerCount()
  await vi.advanceTimersByTimeAsync(500)
  expect(settled).toBe(false)
  expect(list).toHaveBeenCalledTimes(2)
  expect(view(store)).toEqual(empty('loading'))
  const rows = [plugin()]
  gate.resolve(rows)
  await expect(pending).resolves.toBeUndefined()
  expect(store.getState().plugins).toBe(rows)
  expect(view(store)).toEqual({ plugins: rows, panelErrors: {}, fetchStatus: 'ready' })
  expect(timers).toBe(0)
})

it('keeps successful replacement rows and their references after retiring the old error retry', async () => {
  const rows = [plugin()]
  const list = vi
    .fn<List>()
    .mockRejectedValueOnce(new Error('starting'))
    .mockResolvedValueOnce(rows)
  const { store } = await harness(list)
  await store.getState().fetchPlugins()
  await expect(store.getState().fetchPlugins()).resolves.toBeUndefined()
  const timers = vi.getTimerCount()
  await vi.advanceTimersByTimeAsync(500)
  expect(list).toHaveBeenCalledTimes(2)
  expect(store.getState().plugins).toBe(rows)
  expect(view(store)).toEqual({ plugins: rows, panelErrors: {}, fetchStatus: 'ready' })
  expect(timers).toBe(0)
})

it.each([undefined, null, false])(
  'keeps missing/unsupported bridge fallback for %s while releasing an invalid retry',
  async (bridge) => {
    const list = vi.fn<List>().mockRejectedValue(new Error('starting'))
    const { store } = await harness(list)
    await store.getState().fetchPlugins()
    vi.stubGlobal('window', { api: { plugins: bridge } })
    await expect(store.getState().fetchPlugins()).resolves.toBeUndefined()
    const timers = vi.getTimerCount()
    await vi.advanceTimersByTimeAsync(500)
    expect(list).toHaveBeenCalledOnce()
    expect(view(store)).toEqual(empty('ready'))
    expect(timers).toBe(0)
  }
)

it.each(['reject', 'throw'] as const)(
  'keeps the current 500ms retry and original %s error after a second failed request',
  async (kind) => {
    const failure = new Error('same transport error')
    const times: number[] = []
    const list = vi.fn<List>(() => {
      times.push(Date.now())
      if (kind === 'throw') {
        throw failure
      }
      return Promise.reject(failure)
    })
    const { store } = await harness(list)
    await expect(store.getState().fetchPlugins()).resolves.toBeUndefined()
    await expect(store.getState().fetchPlugins()).resolves.toBeUndefined()
    const timers = vi.getTimerCount()
    await vi.advanceTimersByTimeAsync(499)
    expect(times).toEqual([0, 0])
    await vi.advanceTimersByTimeAsync(1)
    expect(times).toEqual([0, 0, 500])
    expect(view(store)).toEqual(empty('error'))
    expect(vi.getTimerCount()).toBe(0)
    if (kind === 'throw') {
      expect(list.mock.results[0]).toMatchObject({ type: 'throw', value: failure })
    } else {
      await expect(list.mock.results[0]?.value).rejects.toBe(failure)
    }
    expect(timers).toBe(1)
  }
)

it('preserves the complete live 250ms/500ms retry schedule and cap', async () => {
  const times: number[] = []
  const failure = new Error('unavailable')
  const list = vi.fn<List>(() => {
    times.push(Date.now())
    return Promise.reject(failure)
  })
  const { store } = await harness(list)
  await store.getState().fetchPlugins()
  expect(vi.getTimerCount()).toBe(1)
  await vi.advanceTimersByTimeAsync(249)
  expect(times).toEqual([0])
  await vi.advanceTimersByTimeAsync(1)
  expect(times).toEqual([0, 250])
  await vi.advanceTimersByTimeAsync(499)
  expect(times).toEqual([0, 250])
  await vi.advanceTimersByTimeAsync(1)
  expect(times).toEqual([0, 250, 750])
  expect(view(store)).toEqual(empty('error'))
  expect(vi.getTimerCount()).toBe(0)
  await vi.advanceTimersByTimeAsync(5000)
  expect(list).toHaveBeenCalledTimes(3)
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

it('preserves existing reentrant error replacement and its already-fenced post-set retry', async () => {
  const list = vi.fn<List>().mockRejectedValue(new Error('starting'))
  const { store } = await harness(list)
  const rows = [plugin()]
  const unsubscribe = store.subscribe((state) => {
    if (state.fetchStatus === 'error') {
      store.getState().setPlugins(rows)
    }
  })
  await store.getState().fetchPlugins()
  expect(vi.getTimerCount()).toBe(1)
  await vi.advanceTimersByTimeAsync(250)
  expect(list).toHaveBeenCalledOnce()
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
