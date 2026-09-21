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
