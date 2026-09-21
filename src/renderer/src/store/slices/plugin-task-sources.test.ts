import { afterEach, describe, expect, it, vi } from 'vitest'
import { create } from 'zustand'
import type { AppState } from '../types'
import type { PluginHostListEntry } from '../../../../preload/api-types'
import type { PluginTaskItem } from '../../../../shared/plugins/plugin-task-source-contract'
import {
  createPluginTaskSourcesSlice,
  deriveContributedPluginTaskSources
} from './plugin-task-sources'

const BOARDS_SOURCE = { pluginKey: 'orca-samples.issues', sourceId: 'boards' }

function createTestStore() {
  return create<AppState>()(
    (...a) =>
      ({
        ...createPluginTaskSourcesSlice(...a)
      }) as AppState
  )
}

function taskItem(id: string): PluginTaskItem {
  return {
    id,
    key: id,
    title: id,
    state: { name: 'To Do', category: 'todo' },
    assignee: null,
    url: null,
    updatedAt: null,
    scopeId: null
  }
}

function pluginEntry(
  overrides: Partial<PluginHostListEntry> & { pluginKey: string }
): PluginHostListEntry {
  return {
    consentFingerprint: 'sha256-test',
    name: overrides.pluginKey,
    version: '1.0.0',
    publisher: 'orca-samples',
    status: 'running',
    needsReconsent: false,
    isDev: false,
    official: false,
    bundled: false,
    capabilities: [],
    panels: [],
    taskSources: [],
    commands: [],
    hasWorker: false,
    restarts: 0,
    ...overrides
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('createPluginTaskSourcesSlice', () => {
  it('populates items from an ok: true envelope', async () => {
    const store = createTestStore()
    const invokeTaskSource = vi.fn().mockResolvedValue({
      ok: true,
      data: { items: [taskItem('a'), taskItem('b')], nextCursor: null }
    })
    vi.stubGlobal('window', { api: { plugins: { invokeTaskSource } } })

    store.getState().selectPluginTaskSource(BOARDS_SOURCE)
    await store.getState().loadPluginTaskSourceItems()

    expect(store.getState().pluginTaskSourceItems.map((item) => item.id)).toEqual(['a', 'b'])
    expect(store.getState().pluginTaskSourceError).toBeNull()
    expect(invokeTaskSource).toHaveBeenCalledWith({
      ...BOARDS_SOURCE,
      method: 'listItems',
      params: { scopeIds: [], search: null, cursor: null, limit: 50 }
    })
  })

  it('carries the active filter and search into the list request', async () => {
    const store = createTestStore()
    const invokeTaskSource = vi
      .fn()
      .mockResolvedValue({ ok: true, data: { items: [], nextCursor: null } })
    vi.stubGlobal('window', { api: { plugins: { invokeTaskSource } } })

    store.getState().selectPluginTaskSource(BOARDS_SOURCE)
    store.getState().setPluginTaskSourceQuery({ search: 'bar', filterId: 'open' })
    await store.getState().loadPluginTaskSourceItems()

    expect(invokeTaskSource).toHaveBeenCalledWith({
      ...BOARDS_SOURCE,
      method: 'listItems',
      params: { scopeIds: [], search: 'bar', cursor: null, limit: 50, filterId: 'open' }
    })
  })

  it('drops a response whose query the user has already replaced', async () => {
    const store = createTestStore()
    let resolveCall!: (value: unknown) => void
    const invokeTaskSource = vi.fn().mockReturnValue(
      new Promise((resolve) => {
        resolveCall = resolve
      })
    )
    vi.stubGlobal('window', { api: { plugins: { invokeTaskSource } } })

    store.getState().selectPluginTaskSource(BOARDS_SOURCE)
    const request = store.getState().loadPluginTaskSourceItems()
    store.getState().setPluginTaskSourceQuery({ search: 'newer', filterId: null })

    resolveCall({ ok: true, data: { items: [taskItem('stale')], nextCursor: null } })
    await request

    expect(store.getState().pluginTaskSourceItems).toEqual([])
  })

  it('loads the scopes a selected source declares', async () => {
    const store = createTestStore()
    const invokeTaskSource = vi.fn().mockResolvedValue({
      ok: true,
      data: [
        { id: 'NssfDevOps/dashboards', name: 'NssfDevOps / Dashboards' },
        { id: 'NssfDevOps/redesign', name: 'NssfDevOps / NssfGo-Redesign' }
      ]
    })
    vi.stubGlobal('window', { api: { plugins: { invokeTaskSource } } })

    store.getState().selectPluginTaskSource(BOARDS_SOURCE)
    await store.getState().loadPluginTaskSourceScopes()

    expect(invokeTaskSource).toHaveBeenCalledWith({ ...BOARDS_SOURCE, method: 'listScopes' })
    expect(store.getState().pluginTaskSourceScopes.map((scope) => scope.name)).toEqual([
      'NssfDevOps / Dashboards',
      'NssfDevOps / NssfGo-Redesign'
    ])
    expect(store.getState().pluginTaskSourceScopesError).toBeNull()
    expect(store.getState().pluginTaskSourceScopesLoading).toBe(false)
  })

  it('reports a listScopes failure rather than an empty scope list', async () => {
    const store = createTestStore()
    const invokeTaskSource = vi
      .fn()
      .mockResolvedValue({ ok: false, code: 'forbidden', message: 'No project read access.' })
    vi.stubGlobal('window', { api: { plugins: { invokeTaskSource } } })

    store.getState().selectPluginTaskSource(BOARDS_SOURCE)
    await store.getState().loadPluginTaskSourceScopes()

    expect(store.getState().pluginTaskSourceScopes).toEqual([])
    expect(store.getState().pluginTaskSourceScopesError).toEqual({
      code: 'forbidden',
      message: 'No project read access.'
    })
  })

  it('narrows the list request to a single selected scope', async () => {
    const store = createTestStore()
    const invokeTaskSource = vi
      .fn()
      .mockResolvedValue({ ok: true, data: { items: [], nextCursor: null } })
    vi.stubGlobal('window', { api: { plugins: { invokeTaskSource } } })

    store.getState().selectPluginTaskSource(BOARDS_SOURCE)
    store.getState().setPluginTaskSourceScopeIds(['NssfDevOps/dashboards'])
    await store.getState().loadPluginTaskSourceItems()

    expect(invokeTaskSource).toHaveBeenCalledWith({
      ...BOARDS_SOURCE,
      method: 'listItems',
      params: {
        scopeIds: ['NssfDevOps/dashboards'],
        search: null,
        cursor: null,
        limit: 50
      }
    })
  })

  it('carries every selected scope into the list request', async () => {
    const store = createTestStore()
    const invokeTaskSource = vi
      .fn()
      .mockResolvedValue({ ok: true, data: { items: [], nextCursor: null } })
    vi.stubGlobal('window', { api: { plugins: { invokeTaskSource } } })

    store.getState().selectPluginTaskSource(BOARDS_SOURCE)
    store.getState().setPluginTaskSourceScopeIds(['NssfDevOps/dashboards', 'nssf-dolphin/platform'])
    await store.getState().loadPluginTaskSourceItems()

    expect(invokeTaskSource).toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({
          scopeIds: ['NssfDevOps/dashboards', 'nssf-dolphin/platform']
        })
      })
    )
  })

  it('asks for every scope again once the selection is cleared', async () => {
    const store = createTestStore()
    const invokeTaskSource = vi
      .fn()
      .mockResolvedValue({ ok: true, data: { items: [], nextCursor: null } })
    vi.stubGlobal('window', { api: { plugins: { invokeTaskSource } } })

    store.getState().selectPluginTaskSource(BOARDS_SOURCE)
    store.getState().setPluginTaskSourceScopeIds(['NssfDevOps/dashboards'])
    await store.getState().loadPluginTaskSourceItems()
    store.getState().setPluginTaskSourceScopeIds([])
    await store.getState().loadPluginTaskSourceItems()

    expect(invokeTaskSource).toHaveBeenLastCalledWith(
      expect.objectContaining({ params: expect.objectContaining({ scopeIds: [] }) })
    )
  })

  it('drops a response whose scope selection the user has already replaced', async () => {
    const store = createTestStore()
    let resolveCall!: (value: unknown) => void
    const invokeTaskSource = vi.fn().mockReturnValue(
      new Promise((resolve) => {
        resolveCall = resolve
      })
    )
    vi.stubGlobal('window', { api: { plugins: { invokeTaskSource } } })

    store.getState().selectPluginTaskSource(BOARDS_SOURCE)
    const request = store.getState().loadPluginTaskSourceItems()
    store.getState().setPluginTaskSourceScopeIds(['NssfDevOps/dashboards'])

    resolveCall({ ok: true, data: { items: [taskItem('stale')], nextCursor: null } })
    await request

    expect(store.getState().pluginTaskSourceItems).toEqual([])
  })

  it('reads declared filters off the status probe', async () => {
    const store = createTestStore()
    const invokeTaskSource = vi.fn().mockResolvedValue({
      ok: true,
      data: {
        connected: true,
        accountLabel: 'Boards',
        notice: null,
        supports: {
          comment: false,
          transition: false,
          assign: false,
          editTitle: false,
          editDescription: false
        },
        filters: [{ id: 'open', label: 'All open' }]
      }
    })
    vi.stubGlobal('window', { api: { plugins: { invokeTaskSource } } })

    store.getState().selectPluginTaskSource(BOARDS_SOURCE)
    await store.getState().loadPluginTaskSourceFilters()

    expect(store.getState().pluginTaskSourceFilters).toEqual([{ id: 'open', label: 'All open' }])
  })

  it('leaves the chip row empty when the status probe fails', async () => {
    const store = createTestStore()
    const invokeTaskSource = vi
      .fn()
      .mockResolvedValue({ ok: false, code: 'unauthorized', message: 'token expired' })
    vi.stubGlobal('window', { api: { plugins: { invokeTaskSource } } })

    store.getState().selectPluginTaskSource(BOARDS_SOURCE)
    await store.getState().loadPluginTaskSourceFilters()

    expect(store.getState().pluginTaskSourceFilters).toEqual([])
    expect(store.getState().pluginTaskSourceError).toBeNull()
  })

  it('sets error and leaves items untouched on an ok: false envelope', async () => {
    const store = createTestStore()
    const invokeTaskSource = vi
      .fn()
      .mockResolvedValue({ ok: false, code: 'unauthorized', message: 'token expired' })
    vi.stubGlobal('window', { api: { plugins: { invokeTaskSource } } })

    store.getState().selectPluginTaskSource(BOARDS_SOURCE)
    store.setState({ pluginTaskSourceItems: [taskItem('existing')] })
    await store.getState().loadPluginTaskSourceItems()

    expect(store.getState().pluginTaskSourceItems.map((item) => item.id)).toEqual(['existing'])
    expect(store.getState().pluginTaskSourceError).toEqual({
      code: 'unauthorized',
      message: 'token expired'
    })
  })

  it('replaces items rather than merging when a different source is selected', async () => {
    const store = createTestStore()
    const invokeTaskSource = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        data: { items: [taskItem('a1'), taskItem('a2')], nextCursor: null }
      })
      .mockResolvedValueOnce({ ok: true, data: { items: [taskItem('b1')], nextCursor: null } })
    vi.stubGlobal('window', { api: { plugins: { invokeTaskSource } } })

    store.getState().selectPluginTaskSource({ pluginKey: 'orca-samples.a', sourceId: 'source-a' })
    await store.getState().loadPluginTaskSourceItems()
    expect(store.getState().pluginTaskSourceItems.map((item) => item.id)).toEqual(['a1', 'a2'])

    store.getState().selectPluginTaskSource({ pluginKey: 'orca-samples.b', sourceId: 'source-b' })
    await store.getState().loadPluginTaskSourceItems()

    expect(store.getState().pluginTaskSourceItems.map((item) => item.id)).toEqual(['b1'])
  })

  it('tracks loading true during the call and false after, on success', async () => {
    const store = createTestStore()
    let resolveCall!: (value: unknown) => void
    const invokeTaskSource = vi.fn().mockReturnValue(
      new Promise((resolve) => {
        resolveCall = resolve
      })
    )
    vi.stubGlobal('window', { api: { plugins: { invokeTaskSource } } })

    store.getState().selectPluginTaskSource(BOARDS_SOURCE)
    const request = store.getState().loadPluginTaskSourceItems()
    expect(store.getState().pluginTaskSourceLoading).toBe(true)

    resolveCall({ ok: true, data: { items: [], nextCursor: null } })
    await request

    expect(store.getState().pluginTaskSourceLoading).toBe(false)
  })

  it('tracks loading true during the call and false after, on failure', async () => {
    const store = createTestStore()
    let resolveCall!: (value: unknown) => void
    const invokeTaskSource = vi.fn().mockReturnValue(
      new Promise((resolve) => {
        resolveCall = resolve
      })
    )
    vi.stubGlobal('window', { api: { plugins: { invokeTaskSource } } })

    store.getState().selectPluginTaskSource(BOARDS_SOURCE)
    const request = store.getState().loadPluginTaskSourceItems()
    expect(store.getState().pluginTaskSourceLoading).toBe(true)

    resolveCall({ ok: false, code: 'unavailable', message: 'worker died' })
    await request

    expect(store.getState().pluginTaskSourceLoading).toBe(false)
  })

  describe('refreshPluginTaskSource', () => {
    it('re-issues listItems carrying the current filter, scopes and search', async () => {
      const store = createTestStore()
      const invokeTaskSource = vi
        .fn()
        .mockResolvedValue({ ok: true, data: { items: [], nextCursor: null } })
      vi.stubGlobal('window', { api: { plugins: { invokeTaskSource } } })

      store.getState().selectPluginTaskSource(BOARDS_SOURCE)
      store.getState().setPluginTaskSourceQuery({ search: 'bar', filterId: 'open' })
      store.getState().setPluginTaskSourceScopeIds(['NssfDevOps/dashboards'])
      invokeTaskSource.mockClear()

      await store.getState().refreshPluginTaskSource()

      expect(invokeTaskSource).toHaveBeenCalledWith({
        ...BOARDS_SOURCE,
        method: 'listItems',
        params: {
          scopeIds: ['NssfDevOps/dashboards'],
          search: 'bar',
          cursor: null,
          limit: 50,
          filterId: 'open'
        }
      })
    })

    it('re-issues listScopes', async () => {
      const store = createTestStore()
      const invokeTaskSource = vi
        .fn()
        .mockResolvedValue({ ok: true, data: { items: [], nextCursor: null } })
      vi.stubGlobal('window', { api: { plugins: { invokeTaskSource } } })

      store.getState().selectPluginTaskSource(BOARDS_SOURCE)
      invokeTaskSource.mockClear()

      await store.getState().refreshPluginTaskSource()

      expect(invokeTaskSource).toHaveBeenCalledWith({ ...BOARDS_SOURCE, method: 'listScopes' })
    })

    it('ignores a second refresh while one is already in flight', async () => {
      const store = createTestStore()
      let resolveItems!: (value: unknown) => void
      const invokeTaskSource = vi.fn().mockImplementation(async (args: { method: string }) => {
        if (args.method === 'listItems') {
          return new Promise((resolve) => {
            resolveItems = resolve
          })
        }
        return { ok: true, data: [] }
      })
      vi.stubGlobal('window', { api: { plugins: { invokeTaskSource } } })

      store.getState().selectPluginTaskSource(BOARDS_SOURCE)
      invokeTaskSource.mockClear()

      const first = store.getState().refreshPluginTaskSource()
      const second = store.getState().refreshPluginTaskSource()
      const listItemsCalls = () =>
        invokeTaskSource.mock.calls.filter(([args]) => args.method === 'listItems').length
      expect(listItemsCalls()).toBe(1)

      resolveItems({ ok: true, data: { items: [], nextCursor: null } })
      await Promise.all([first, second])

      expect(listItemsCalls()).toBe(1)
      expect(store.getState().pluginTaskSourceRefreshing).toBe(false)
    })

    it('surfaces a refresh failure the same way a normal load failure is surfaced', async () => {
      const store = createTestStore()
      const invokeTaskSource = vi.fn().mockImplementation(async (args: { method: string }) => {
        if (args.method === 'listItems') {
          return { ok: false, code: 'unavailable', message: 'worker died' }
        }
        return { ok: true, data: [] }
      })
      vi.stubGlobal('window', { api: { plugins: { invokeTaskSource } } })

      store.getState().selectPluginTaskSource(BOARDS_SOURCE)
      store.setState({ pluginTaskSourceItems: [taskItem('stale-but-shown')] })

      await store.getState().refreshPluginTaskSource()

      expect(store.getState().pluginTaskSourceError).toEqual({
        code: 'unavailable',
        message: 'worker died'
      })
      expect(store.getState().pluginTaskSourceRefreshing).toBe(false)
    })
  })
})

describe('deriveContributedPluginTaskSources', () => {
  it('flattens task sources from running, restarting, and idle plugins only', () => {
    const plugins: PluginHostListEntry[] = [
      pluginEntry({
        pluginKey: 'orca-samples.issues',
        status: 'running',
        taskSources: [{ id: 'boards', title: 'Boards', icon: 'kanban' }]
      }),
      pluginEntry({
        pluginKey: 'orca-samples.pending',
        status: 'pending',
        taskSources: [{ id: 'hidden', title: 'Hidden' }]
      })
    ]

    expect(deriveContributedPluginTaskSources(plugins)).toEqual([
      { pluginKey: 'orca-samples.issues', sourceId: 'boards', title: 'Boards', icon: 'kanban' }
    ])
  })
})
