// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'

import { useAppStore } from '@/store'
import { createGlobalSettingsFixture } from '../../../../shared/global-settings-test-fixture'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { PersistedPluginTaskSourceSelection } from '../../../../shared/plugins/plugin-task-source-selection-persistence'

const BOARDS = { pluginKey: 'orca-samples.issues', sourceId: 'boards' }
const EPICS = { pluginKey: 'orca-samples.issues', sourceId: 'epics' }
const BOARDS_KEY = 'orca-samples.issues:boards'

/** Neither id is any provider's vocabulary: core reads the declaration, not the
 *  spelling. */
const OWNER_OPTIONS = [
  { id: 'mine', label: 'Me' },
  { id: 'nobody', label: 'Unassigned' }
]

const SCOPES = [
  { id: 'proj-1', name: 'Dashboards' },
  { id: 'proj-2', name: 'Platform' }
]

const OWNER_FACET = {
  id: 'owner',
  label: 'Owner',
  kind: 'multi',
  dynamic: true,
  defaultOptionIds: ['mine']
}

const STATUS = {
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
  facets: [OWNER_FACET]
}

function stubSource({ scopes = SCOPES }: { scopes?: typeof SCOPES } = {}): ReturnType<
  typeof vi.fn
> {
  const invoke = vi.fn().mockImplementation(async (args: { method: string }) => {
    if (args.method === 'status') {
      return { ok: true, data: STATUS }
    }
    if (args.method === 'listScopes') {
      return { ok: true, data: scopes }
    }
    if (args.method === 'listFacetOptions') {
      return { ok: true, data: OWNER_OPTIONS }
    }
    return { ok: true, data: { items: [], nextCursor: null } }
  })
  vi.stubGlobal(
    'window',
    Object.assign(globalThis.window, { api: { plugins: { invokeTaskSource: invoke } } })
  )
  return invoke
}

/** Stands in for the settings slice's IPC write: records each update and folds
 *  it back into the store, so a later read sees what the save left behind. */
function seedSettings(
  saved: Record<string, PersistedPluginTaskSourceSelection> = {}
): Partial<GlobalSettings>[] {
  let settings = createGlobalSettingsFixture({ pluginTaskSourceSelections: saved })
  const writes: Partial<GlobalSettings>[] = []
  useAppStore.setState({
    settings,
    updateSettings: async (updates) => {
      writes.push(updates)
      settings = { ...settings, ...updates }
      useAppStore.setState({ settings })
    }
  })
  return writes
}

/** A restart carries over only what reached settings. */
function reopenOrca(): Record<string, PersistedPluginTaskSourceSelection> {
  const saved = savedSelections()
  useAppStore.setState(useAppStore.getInitialState(), true)
  seedSettings(saved)
  return saved
}

function savedSelections(): Record<string, PersistedPluginTaskSourceSelection> {
  return useAppStore.getState().settings?.pluginTaskSourceSelections ?? {}
}

async function openSource(selection: typeof BOARDS): Promise<void> {
  useAppStore.getState().selectPluginTaskSource(selection)
  await useAppStore.getState().loadPluginTaskSourceStatus()
  await useAppStore.getState().loadPluginTaskSourceScopes()
  await useAppStore.getState().loadPluginTaskSourceFacetOptions()
}

/** The setters save without awaiting, so the write lands a microtask later. */
async function flushSaves(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

function facetSelections(): Record<string, string[]> {
  return useAppStore.getState().pluginTaskSourceQuery.facetSelections
}

function chooseOwner(optionIds: string[]): void {
  useAppStore.getState().setPluginTaskSourceQuery({
    search: null,
    filterId: null,
    facetSelections: { owner: optionIds }
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
  useAppStore.setState(useAppStore.getInitialState(), true)
})

describe('contributed task source filter persistence', () => {
  it('saves the facet selection and the project the user leaves a source on', async () => {
    stubSource()
    seedSettings()
    await openSource(BOARDS)

    chooseOwner(['nobody'])
    useAppStore.getState().setPluginTaskSourceScopeIds(['proj-2'])
    await flushSaves()

    expect(savedSelections()).toEqual({
      [BOARDS_KEY]: { facetSelections: { owner: ['nobody'] }, scopeIds: ['proj-2'] }
    })
  })

  it('restores the saved source and still applies the declared default to a source with nothing saved', async () => {
    stubSource()
    seedSettings({
      [BOARDS_KEY]: { facetSelections: { owner: ['nobody'] }, scopeIds: ['proj-2'] }
    })

    await openSource(BOARDS)
    expect(facetSelections()).toEqual({ owner: ['nobody'] })
    expect(useAppStore.getState().selectedPluginTaskSourceScopeIds).toEqual(['proj-2'])

    await openSource(EPICS)
    expect(facetSelections()).toEqual({ owner: ['mine'] })
    expect(useAppStore.getState().selectedPluginTaskSourceScopeIds).toEqual([])
  })

  it('leaves a facet the user cleared cleared across a restart', async () => {
    stubSource()
    seedSettings()
    await openSource(BOARDS)
    expect(facetSelections()).toEqual({ owner: ['mine'] })

    useAppStore
      .getState()
      .setPluginTaskSourceQuery({ search: null, filterId: null, facetSelections: {} })
    await flushSaves()

    reopenOrca()
    stubSource()
    await openSource(BOARDS)

    expect(facetSelections()).toEqual({})
  })

  it('drops a saved option the source no longer offers and keeps the rest', async () => {
    stubSource()
    seedSettings({
      [BOARDS_KEY]: { facetSelections: { owner: ['mine', 'retired'] }, scopeIds: [] }
    })

    await openSource(BOARDS)

    expect(facetSelections()).toEqual({ owner: ['mine'] })
  })

  it('does not re-seed the declared default over a facet pruned to nothing', async () => {
    stubSource()
    seedSettings({ [BOARDS_KEY]: { facetSelections: { owner: ['retired'] }, scopeIds: [] } })

    await openSource(BOARDS)

    expect(facetSelections()).toEqual({})
  })

  it('falls back to the default scope when the saved project is gone', async () => {
    const invoke = stubSource()
    seedSettings({ [BOARDS_KEY]: { facetSelections: {}, scopeIds: ['proj-retired'] } })

    await openSource(BOARDS)
    await useAppStore.getState().loadPluginTaskSourceItems()

    expect(useAppStore.getState().selectedPluginTaskSourceScopeIds).toEqual([])
    expect(invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'listItems',
        params: expect.objectContaining({ scopeIds: [] })
      })
    )
  })

  it('writes nothing when a declared default seeds or the search text changes', async () => {
    stubSource()
    const writes = seedSettings()

    await openSource(BOARDS)
    await flushSaves()
    expect(writes).toEqual([])

    useAppStore.getState().setPluginTaskSourceQuery({
      search: 'ship',
      filterId: 'open',
      facetSelections: { ...facetSelections() }
    })
    useAppStore.getState().setPluginTaskSourceScopeIds([])
    await flushSaves()

    expect(writes).toEqual([])
  })
})
