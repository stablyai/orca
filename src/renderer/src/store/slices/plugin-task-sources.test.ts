import { afterEach, describe, expect, it, vi } from 'vitest'
import { create } from 'zustand'
import { createGlobalSettingsFixture } from '../../../../shared/global-settings-test-fixture'
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
    store
      .getState()
      .setPluginTaskSourceQuery({ search: 'bar', filterId: 'open', facetSelections: {} })
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
    store
      .getState()
      .setPluginTaskSourceQuery({ search: 'newer', filterId: null, facetSelections: {} })

    resolveCall({ ok: true, data: { items: [taskItem('stale')], nextCursor: null } })
    await request

    expect(store.getState().pluginTaskSourceItems).toEqual([])
  })

  it('loads the scopes a selected source declares', async () => {
    const store = createTestStore()
    const invokeTaskSource = vi.fn().mockResolvedValue({
      ok: true,
      data: [
        { id: 'FabrikamOps/dashboards', name: 'FabrikamOps / Dashboards' },
        { id: 'FabrikamOps/redesign', name: 'FabrikamOps / Portal-Redesign' }
      ]
    })
    vi.stubGlobal('window', { api: { plugins: { invokeTaskSource } } })

    store.getState().selectPluginTaskSource(BOARDS_SOURCE)
    await store.getState().loadPluginTaskSourceScopes()

    expect(invokeTaskSource).toHaveBeenCalledWith({ ...BOARDS_SOURCE, method: 'listScopes' })
    expect(store.getState().pluginTaskSourceScopes.map((scope) => scope.name)).toEqual([
      'FabrikamOps / Dashboards',
      'FabrikamOps / Portal-Redesign'
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
    store.getState().setPluginTaskSourceScopeIds(['FabrikamOps/dashboards'])
    await store.getState().loadPluginTaskSourceItems()

    expect(invokeTaskSource).toHaveBeenCalledWith({
      ...BOARDS_SOURCE,
      method: 'listItems',
      params: {
        scopeIds: ['FabrikamOps/dashboards'],
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
    store.getState().setPluginTaskSourceScopeIds(['FabrikamOps/dashboards', 'contoso-labs/platform'])
    await store.getState().loadPluginTaskSourceItems()

    expect(invokeTaskSource).toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({
          scopeIds: ['FabrikamOps/dashboards', 'contoso-labs/platform']
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
    store.getState().setPluginTaskSourceScopeIds(['FabrikamOps/dashboards'])
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
    store.getState().setPluginTaskSourceScopeIds(['FabrikamOps/dashboards'])

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
          create: true,
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
    await store.getState().loadPluginTaskSourceStatus()

    expect(store.getState().pluginTaskSourceFilters).toEqual([{ id: 'open', label: 'All open' }])
    expect(store.getState().pluginTaskSourceSupportsCreate).toBe(true)
    expect(store.getState().pluginTaskSourceSupportsComment).toBe(false)
  })

  it('leaves the chip row empty when the status probe fails', async () => {
    const store = createTestStore()
    const invokeTaskSource = vi
      .fn()
      .mockResolvedValue({ ok: false, code: 'unauthorized', message: 'token expired' })
    vi.stubGlobal('window', { api: { plugins: { invokeTaskSource } } })

    store.getState().selectPluginTaskSource(BOARDS_SOURCE)
    await store.getState().loadPluginTaskSourceStatus()

    expect(store.getState().pluginTaskSourceFilters).toEqual([])
    expect(store.getState().pluginTaskSourceSupportsCreate).toBe(false)
    expect(store.getState().pluginTaskSourceSupportsComment).toBe(false)
    expect(store.getState().pluginTaskSourceError).toBeNull()
  })

  it('asks for item types in the named scope rather than the source default', async () => {
    const store = createTestStore()
    const invokeTaskSource = vi
      .fn()
      .mockResolvedValue({ ok: true, data: [{ id: 'Bug', name: 'Bug' }] })
    vi.stubGlobal('window', { api: { plugins: { invokeTaskSource } } })

    store.getState().selectPluginTaskSource(BOARDS_SOURCE)
    const result = await store.getState().listPluginTaskSourceItemTypes('FabrikamOps/dashboards')

    expect(result).toEqual({ ok: true, data: [{ id: 'Bug', name: 'Bug' }] })
    expect(invokeTaskSource).toHaveBeenCalledWith({
      ...BOARDS_SOURCE,
      method: 'listItemTypes',
      params: { scopeId: 'FabrikamOps/dashboards' }
    })
  })

  it('returns the created item envelope without touching the loaded list', async () => {
    const store = createTestStore()
    const invokeTaskSource = vi.fn().mockResolvedValue({ ok: true, data: taskItem('new') })
    vi.stubGlobal('window', { api: { plugins: { invokeTaskSource } } })

    store.getState().selectPluginTaskSource(BOARDS_SOURCE)
    store.setState({ pluginTaskSourceItems: [taskItem('existing')] })
    const input = {
      scopeId: 'FabrikamOps/dashboards',
      typeId: 'Bug',
      title: 'Ship the create dialog'
    }
    const result = await store.getState().createPluginTaskSourceItem(input)

    expect(result.ok).toBe(true)
    expect(invokeTaskSource).toHaveBeenCalledWith({
      ...BOARDS_SOURCE,
      method: 'createItem',
      params: input
    })
    expect(store.getState().pluginTaskSourceItems.map((item) => item.id)).toEqual(['existing'])
  })

  it('reports a create failure as an envelope rather than the page error banner', async () => {
    const store = createTestStore()
    const invokeTaskSource = vi
      .fn()
      .mockResolvedValue({ ok: false, code: 'forbidden', message: 'No permission.' })
    vi.stubGlobal('window', { api: { plugins: { invokeTaskSource } } })

    store.getState().selectPluginTaskSource(BOARDS_SOURCE)
    const result = await store
      .getState()
      .createPluginTaskSourceItem({ scopeId: 's', typeId: 'Bug', title: 'x' })

    expect(result).toEqual({ ok: false, code: 'forbidden', message: 'No permission.' })
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
      store
        .getState()
        .setPluginTaskSourceQuery({ search: 'bar', filterId: 'open', facetSelections: {} })
      store.getState().setPluginTaskSourceScopeIds(['FabrikamOps/dashboards'])
      invokeTaskSource.mockClear()

      await store.getState().refreshPluginTaskSource()

      expect(invokeTaskSource).toHaveBeenCalledWith({
        ...BOARDS_SOURCE,
        method: 'listItems',
        params: {
          scopeIds: ['FabrikamOps/dashboards'],
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

  describe('item detail', () => {
    it('asks the source for one item and its comments by id', async () => {
      const store = createTestStore()
      const invokeTaskSource = vi.fn().mockImplementation(async (args: { method: string }) => {
        if (args.method === 'getItem') {
          return { ok: true, data: { ...taskItem('BOARD-7'), description: 'Body' } }
        }
        return {
          ok: true,
          data: [
            {
              id: 'c1',
              author: { id: 'u1', displayName: 'Amelia Kato' },
              body: 'Looks good.',
              bodyFormat: 'markdown',
              createdAt: '2026-01-02T03:04:05.000Z'
            }
          ]
        }
      })
      vi.stubGlobal('window', { api: { plugins: { invokeTaskSource } } })
      store.getState().selectPluginTaskSource(BOARDS_SOURCE)

      const detail = await store.getState().getPluginTaskSourceItem('BOARD-7')
      const comments = await store.getState().listPluginTaskSourceComments('BOARD-7')

      expect(invokeTaskSource).toHaveBeenCalledWith({
        ...BOARDS_SOURCE,
        method: 'getItem',
        params: { id: 'BOARD-7' }
      })
      expect(invokeTaskSource).toHaveBeenCalledWith({
        ...BOARDS_SOURCE,
        method: 'listComments',
        params: { id: 'BOARD-7' }
      })
      // Defaulted by the contract, so a source that omits it cannot have its
      // body parsed as markdown by accident.
      expect(detail.ok && detail.data.descriptionFormat).toBe('text')
      expect(comments.ok && comments.data).toHaveLength(1)
    })

    it('returns each failure as its own envelope rather than empty data', async () => {
      const store = createTestStore()
      const invokeTaskSource = vi.fn().mockImplementation(async (args: { method: string }) => {
        if (args.method === 'getItem') {
          return { ok: true, data: taskItem('BOARD-7') }
        }
        return { ok: false, code: 'unavailable', message: 'comments are down' }
      })
      vi.stubGlobal('window', { api: { plugins: { invokeTaskSource } } })
      store.getState().selectPluginTaskSource(BOARDS_SOURCE)

      const detail = await store.getState().getPluginTaskSourceItem('BOARD-7')
      const comments = await store.getState().listPluginTaskSourceComments('BOARD-7')

      expect(detail.ok).toBe(true)
      expect(comments).toEqual({ ok: false, code: 'unavailable', message: 'comments are down' })
    })
  })
})

const FACET_STATUS = {
  connected: true,
  accountLabel: 'Boards',
  notice: null,
  supports: {
    create: false,
    comment: false,
    transition: false,
    assign: false,
    editTitle: false,
    editDescription: false
  },
  facets: [
    { id: 'state', label: 'State', kind: 'multi', dynamic: true },
    { id: 'type', label: 'Type', kind: 'multi', options: [{ id: 'Bug', label: 'Bug' }] }
  ]
}

/** Neither id is any provider's vocabulary: core reads the declaration, not the
 *  spelling, and a fixture that borrowed a real one would hide a hardcoded id. */
const OWNER_OPTIONS = [
  { id: 'mine', label: 'Me' },
  { id: 'nobody', label: 'Unassigned' }
]

function seededFacetStore(facet: {
  defaultOptionIds?: string[]
}): ReturnType<typeof createTestStore> {
  const store = createTestStore()
  const invokeTaskSource = vi.fn().mockImplementation(async (args: { method: string }) => {
    if (args.method === 'status') {
      return {
        ok: true,
        data: {
          ...FACET_STATUS,
          facets: [{ id: 'owner', label: 'Owner', kind: 'multi', dynamic: true, ...facet }]
        }
      }
    }
    return { ok: true, data: OWNER_OPTIONS }
  })
  vi.stubGlobal('window', { api: { plugins: { invokeTaskSource } } })
  store.getState().selectPluginTaskSource(BOARDS_SOURCE)
  return store
}

describe('contributed task source facets in the store', () => {
  it('carries the chosen facet options into the list request', async () => {
    const store = createTestStore()
    const invokeTaskSource = vi
      .fn()
      .mockResolvedValue({ ok: true, data: { items: [], nextCursor: null } })
    vi.stubGlobal('window', { api: { plugins: { invokeTaskSource } } })

    store.getState().selectPluginTaskSource(BOARDS_SOURCE)
    store.getState().setPluginTaskSourceQuery({
      search: null,
      filterId: null,
      facetSelections: { state: ['Active', 'New'], sprint: ['Sprint 1'] }
    })
    // Only facets whose options have settled for this scope are sent.
    store.setState({
      pluginTaskSourceFacetOptions: {
        state: { status: 'ready', options: [] },
        sprint: { status: 'ready', options: [] }
      }
    })
    await store.getState().loadPluginTaskSourceItems()

    expect(invokeTaskSource).toHaveBeenCalledWith({
      ...BOARDS_SOURCE,
      method: 'listItems',
      params: {
        scopeIds: [],
        search: null,
        cursor: null,
        limit: 50,
        facetSelections: { state: ['Active', 'New'], sprint: ['Sprint 1'] }
      }
    })
  })

  it('asks for a dynamic facet in the selected scope and answers a static one from its declaration', async () => {
    const store = createTestStore()
    const invokeTaskSource = vi.fn().mockImplementation(async (args: { method: string }) => {
      if (args.method === 'status') {
        return { ok: true, data: FACET_STATUS }
      }
      return { ok: true, data: [{ id: 'Active', label: 'Active' }] }
    })
    vi.stubGlobal('window', { api: { plugins: { invokeTaskSource } } })

    store.getState().selectPluginTaskSource(BOARDS_SOURCE)
    store.getState().setPluginTaskSourceScopeIds(['FabrikamOps/dashboards'])
    await store.getState().loadPluginTaskSourceStatus()
    await store.getState().loadPluginTaskSourceFacetOptions()

    expect(invokeTaskSource).toHaveBeenCalledWith({
      ...BOARDS_SOURCE,
      method: 'listFacetOptions',
      params: { facetId: 'state', scopeIds: ['FabrikamOps/dashboards'] }
    })
    expect(invokeTaskSource).not.toHaveBeenCalledWith(
      expect.objectContaining({ params: { facetId: 'type', scopeIds: ['FabrikamOps/dashboards'] } })
    )
    expect(store.getState().pluginTaskSourceFacetOptions).toEqual({
      state: { status: 'ready', options: [{ id: 'Active', label: 'Active' }] },
      type: { status: 'ready', options: [{ id: 'Bug', label: 'Bug' }] }
    })
  })

  it('marks a facet whose options fail as failed rather than as offering none', async () => {
    const store = createTestStore()
    const invokeTaskSource = vi.fn().mockImplementation(async (args: { method: string }) => {
      if (args.method === 'status') {
        return { ok: true, data: FACET_STATUS }
      }
      return { ok: false, code: 'rate_limited', message: 'Too many board queries.' }
    })
    vi.stubGlobal('window', { api: { plugins: { invokeTaskSource } } })

    store.getState().selectPluginTaskSource(BOARDS_SOURCE)
    await store.getState().loadPluginTaskSourceStatus()
    await store.getState().loadPluginTaskSourceFacetOptions()

    expect(store.getState().pluginTaskSourceFacetOptions.state).toEqual({
      status: 'failed',
      error: { code: 'rate_limited', message: 'Too many board queries.' }
    })
  })

  it('seeds a facet to the options its declaration names', async () => {
    const store = seededFacetStore({ defaultOptionIds: ['mine'] })
    await store.getState().loadPluginTaskSourceStatus()
    await store.getState().loadPluginTaskSourceFacetOptions()

    expect(store.getState().pluginTaskSourceQuery.facetSelections).toEqual({ owner: ['mine'] })
  })

  it('seeds every declared default on a multi-select facet', async () => {
    const store = seededFacetStore({ defaultOptionIds: ['mine', 'nobody'] })
    await store.getState().loadPluginTaskSourceStatus()
    await store.getState().loadPluginTaskSourceFacetOptions()

    expect(store.getState().pluginTaskSourceQuery.facetSelections).toEqual({
      owner: ['mine', 'nobody']
    })
  })

  it('opens unfiltered when the facet declares no default', async () => {
    const store = seededFacetStore({})
    await store.getState().loadPluginTaskSourceStatus()
    await store.getState().loadPluginTaskSourceFacetOptions()

    expect(store.getState().pluginTaskSourceQuery.facetSelections).toEqual({})
  })

  it('drops a declared default this scope does not offer and keeps the rest', async () => {
    const store = seededFacetStore({ defaultOptionIds: ['retired', 'mine'] })
    await store.getState().loadPluginTaskSourceStatus()
    await store.getState().loadPluginTaskSourceFacetOptions()

    expect(store.getState().pluginTaskSourceQuery.facetSelections).toEqual({ owner: ['mine'] })
    expect(store.getState().pluginTaskSourceFacetOptions.owner).toEqual({
      status: 'ready',
      options: OWNER_OPTIONS
    })
  })

  it('leaves the list unfiltered when no declared default survives the scope', async () => {
    const store = seededFacetStore({ defaultOptionIds: ['retired'] })
    await store.getState().loadPluginTaskSourceStatus()
    await store.getState().loadPluginTaskSourceFacetOptions()

    expect(store.getState().pluginTaskSourceQuery.facetSelections).toEqual({})
    expect(store.getState().pluginTaskSourceFacetOptions.owner).toEqual({
      status: 'ready',
      options: OWNER_OPTIONS
    })
  })

  it('does not re-apply a declared default the user has cleared', async () => {
    const store = seededFacetStore({ defaultOptionIds: ['mine'] })
    await store.getState().loadPluginTaskSourceStatus()
    await store.getState().loadPluginTaskSourceFacetOptions()
    expect(store.getState().pluginTaskSourceQuery.facetSelections).toEqual({ owner: ['mine'] })

    store.getState().setPluginTaskSourceQuery({ search: null, filterId: null, facetSelections: {} })
    store.getState().setPluginTaskSourceScopeIds(['FabrikamOps/dashboards'])
    await store.getState().loadPluginTaskSourceFacetOptions()

    expect(store.getState().pluginTaskSourceQuery.facetSelections).toEqual({})
  })

  it('retires a chosen option the newly selected scope does not offer', async () => {
    const store = createTestStore()
    const invokeTaskSource = vi.fn().mockImplementation(async (args: { method: string }) => {
      if (args.method === 'status') {
        return { ok: true, data: FACET_STATUS }
      }
      if (args.method === 'listFacetOptions') {
        return { ok: true, data: [{ id: 'Active', label: 'Active' }] }
      }
      return { ok: true, data: { items: [], nextCursor: null } }
    })
    vi.stubGlobal('window', { api: { plugins: { invokeTaskSource } } })

    store.getState().selectPluginTaskSource(BOARDS_SOURCE)
    await store.getState().loadPluginTaskSourceStatus()
    store.getState().setPluginTaskSourceQuery({
      search: null,
      filterId: null,
      facetSelections: { state: ['Active', 'Retired'], type: ['Bug'] }
    })
    await store.getState().loadPluginTaskSourceFacetOptions()

    expect(store.getState().pluginTaskSourceQuery.facetSelections).toEqual({
      state: ['Active'],
      type: ['Bug']
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
  it('reloads facet options for the scopes that survived a scope drop', async () => {
    // Without this the facet load already in flight discards its own callbacks
    // (their scope set moved on) and every facet stays on `loading` forever.
    const store = createTestStore()
    const invokeTaskSource = vi.fn(async ({ method }: { method: string }) => {
      if (method === 'status') {
        return {
          ok: true,
          data: {
            connected: true,
            supports: { create: false, comment: false },
            facets: [{ id: 'state', label: 'State', kind: 'multi', dynamic: true }]
          }
        }
      }
      if (method === 'listScopes') {
        return { ok: true, data: [{ id: 'org/kept', name: 'org / kept' }] }
      }
      if (method === 'listFacetOptions') {
        return { ok: true, data: [{ id: 'Active', label: 'Active' }] }
      }
      return { ok: true, data: [] }
    })
    vi.stubGlobal('window', { api: { plugins: { invokeTaskSource } } })

    store.getState().selectPluginTaskSource(BOARDS_SOURCE)
    store.setState({
      selectedPluginTaskSourceScopeIds: ['org/kept', 'org/gone'],
      pluginTaskSourceFacets: [{ id: 'state', label: 'State', kind: 'multi', dynamic: true }]
    })
    await store.getState().loadPluginTaskSourceScopes()

    expect(store.getState().selectedPluginTaskSourceScopeIds).toEqual(['org/kept'])
    const facetCalls = invokeTaskSource.mock.calls.filter(
      ([args]) => args.method === 'listFacetOptions'
    )
    expect(facetCalls.length).toBeGreaterThan(0)
  })

  it('does not reload facet options when every selected scope survives', async () => {
    const store = createTestStore()
    const invokeTaskSource = vi.fn(async ({ method }: { method: string }) => {
      if (method === 'listScopes') {
        return { ok: true, data: [{ id: 'org/kept', name: 'org / kept' }] }
      }
      return { ok: true, data: [] }
    })
    vi.stubGlobal('window', { api: { plugins: { invokeTaskSource } } })

    store.getState().selectPluginTaskSource(BOARDS_SOURCE)
    store.setState({
      selectedPluginTaskSourceScopeIds: ['org/kept'],
      pluginTaskSourceFacets: [{ id: 'state', label: 'State', kind: 'multi', dynamic: true }]
    })
    await store.getState().loadPluginTaskSourceScopes()

    expect(
      invokeTaskSource.mock.calls.filter(
        ([args]) => args.method === 'listFacetOptions'
      )
    ).toEqual([])
  })

  it('omits a facet whose options have not settled for the scope on screen', async () => {
    // A scope change loads items and facet options in the same commit, so an
    // unsettled facet still holds the previous project's option ids. The source
    // refuses an id it cannot resolve, so sending one fails the whole list.
    const store = createTestStore()
    const invokeTaskSource = vi
      .fn()
      .mockResolvedValue({ ok: true, data: { items: [], nextCursor: null } })
    vi.stubGlobal('window', { api: { plugins: { invokeTaskSource } } })

    store.getState().selectPluginTaskSource(BOARDS_SOURCE)
    store.getState().setPluginTaskSourceQuery({
      search: null,
      filterId: null,
      facetSelections: { state: ['Active'], sprint: ['org/proj\u0000Sprint 1'] }
    })
    store.setState({
      pluginTaskSourceFacetOptions: {
        state: { status: 'ready', options: [] },
        sprint: { status: 'loading' }
      }
    })
    await store.getState().loadPluginTaskSourceItems()

    expect(invokeTaskSource).toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({ facetSelections: { state: ['Active'] } })
      })
    )
  })

  it('sends no facetSelections at all when none have settled', async () => {
    const store = createTestStore()
    const invokeTaskSource = vi
      .fn()
      .mockResolvedValue({ ok: true, data: { items: [], nextCursor: null } })
    vi.stubGlobal('window', { api: { plugins: { invokeTaskSource } } })

    store.getState().selectPluginTaskSource(BOARDS_SOURCE)
    store.getState().setPluginTaskSourceQuery({
      search: null,
      filterId: null,
      facetSelections: { state: ['Active'] }
    })
    store.setState({ pluginTaskSourceFacetOptions: { state: { status: 'loading' } } })
    await store.getState().loadPluginTaskSourceItems()

    const params = invokeTaskSource.mock.calls[0][0].params
    expect('facetSelections' in params).toBe(false)
  })

  it('keeps a selection whose options failed rather than discarding it', async () => {
    // Not sending it is a widened response; dropping it loses the user's filter
    // to a transient error, which they never asked for.
    const store = createTestStore()
    const invokeTaskSource = vi
      .fn()
      .mockResolvedValue({ ok: true, data: { items: [], nextCursor: null } })
    vi.stubGlobal('window', { api: { plugins: { invokeTaskSource } } })

    store.getState().selectPluginTaskSource(BOARDS_SOURCE)
    store.getState().setPluginTaskSourceQuery({
      search: null,
      filterId: null,
      facetSelections: { state: ['Active'] }
    })
    store.setState({
      pluginTaskSourceFacetOptions: {
        state: { status: 'failed', error: { code: 'unavailable', message: 'nope' } }
      }
    })
    await store.getState().loadPluginTaskSourceItems()

    expect(store.getState().pluginTaskSourceQuery.facetSelections).toEqual({ state: ['Active'] })
  })

  it('persists a scope drop so the next launch does not restore it', async () => {
    // Kept in memory only, the retired scope comes back from settings on the
    // next launch, reaches listItems again, and is dropped again — forever.
    const store = createTestStore()
    const invokeTaskSource = vi.fn(async ({ method }: { method: string }) => {
      if (method === 'listScopes') {
        return { ok: true, data: [{ id: 'org/kept', name: 'org / kept' }] }
      }
      return { ok: true, data: [] }
    })
    const updateSettings = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('window', { api: { plugins: { invokeTaskSource } } })

    store.getState().selectPluginTaskSource(BOARDS_SOURCE)
    store.setState({
      selectedPluginTaskSourceScopeIds: ['org/kept', 'org/gone'],
      settings: createGlobalSettingsFixture({ pluginTaskSourceSelections: {} }),
      updateSettings
    })
    await store.getState().loadPluginTaskSourceScopes()
    await Promise.resolve()

    expect(updateSettings).toHaveBeenCalledWith({
      pluginTaskSourceSelections: {
        'orca-samples.issues:boards': expect.objectContaining({ scopeIds: ['org/kept'] })
      }
    })
  })

  it('reloads items and clears the spinner after a scope drop', async () => {
    // The in-flight items load discards itself on the stale guard, which
    // returns without clearing pluginTaskSourceLoading — so without a reload
    // the list spins forever.
    const store = createTestStore()
    const invokeTaskSource = vi.fn(async ({ method }: { method: string }) => {
      if (method === 'listScopes') {
        return { ok: true, data: [{ id: 'org/kept', name: 'org / kept' }] }
      }
      if (method === 'listItems') {
        return { ok: true, data: { items: [], nextCursor: null } }
      }
      return { ok: true, data: [] }
    })
    vi.stubGlobal('window', { api: { plugins: { invokeTaskSource } } })

    store.getState().selectPluginTaskSource(BOARDS_SOURCE)
    store.setState({
      selectedPluginTaskSourceScopeIds: ['org/kept', 'org/gone'],
      pluginTaskSourceLoading: true
    })
    await store.getState().loadPluginTaskSourceScopes()

    const itemCalls = invokeTaskSource.mock.calls.filter(
      ([args]) => args.method === 'listItems'
    )
    expect(itemCalls.length).toBeGreaterThan(0)
    expect(store.getState().pluginTaskSourceLoading).toBe(false)
  })

})
