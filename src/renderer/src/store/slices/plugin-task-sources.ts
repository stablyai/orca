import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { PluginHostListEntry } from '../../../../preload/api-types'
import { z } from 'zod'
import {
  pluginTaskPageSchema,
  pluginTaskScopeSchema,
  pluginTaskSourceStatusSchema,
  type PluginTaskPage,
  type PluginTaskQuery,
  type PluginTaskScope,
  type PluginTaskSourceResult
} from '../../../../shared/plugins/plugin-task-source-contract'
import type {
  ContributedPluginTaskSource,
  PluginTaskSourceFilter,
  PluginTaskSourceQuery,
  PluginTaskSourcesSlice,
  SelectedPluginTaskSource
} from './plugin-task-sources-slice-contract'

export type {
  ContributedPluginTaskSource,
  PluginTaskSourceFilter,
  PluginTaskSourceLoadError,
  PluginTaskSourceQuery,
  PluginTaskSourcesSlice,
  SelectedPluginTaskSource
} from './plugin-task-sources-slice-contract'

const PLUGIN_TASK_SOURCE_PAGE_SIZE = 50
const UNFILTERED_QUERY: PluginTaskSourceQuery = { search: null, filterId: null }
const ALL_SCOPES: string[] = []

const pluginTaskScopeListSchema = z.array(pluginTaskScopeSchema)

/** `filterId` is omitted rather than sent as null so a source that never
 *  declared filters sees the exact request it saw before they existed. */
function buildListQuery(query: PluginTaskSourceQuery, scopeIds: string[]): PluginTaskQuery {
  return {
    scopeIds,
    search: query.search,
    cursor: null,
    limit: PLUGIN_TASK_SOURCE_PAGE_SIZE,
    ...(query.filterId ? { filterId: query.filterId } : {})
  }
}

/** Contributions of enabled plugins, flattened for the Tasks source bar.
 *  Mirrors the status filter `collectActivePluginPanels` uses in
 *  `store/plugin-panels.ts` — `idle` still contributes because a source's
 *  worker activates lazily on first call. */
export function deriveContributedPluginTaskSources(
  plugins: readonly PluginHostListEntry[]
): ContributedPluginTaskSource[] {
  return plugins
    .filter(
      (plugin) =>
        plugin.status === 'running' || plugin.status === 'restarting' || plugin.status === 'idle'
    )
    .flatMap((plugin) =>
      plugin.taskSources.map((source) => ({
        pluginKey: plugin.pluginKey,
        sourceId: source.id,
        title: source.title,
        ...(source.icon ? { icon: source.icon } : {})
      }))
    )
}

function isSameSelection(a: SelectedPluginTaskSource | null, b: SelectedPluginTaskSource): boolean {
  return a !== null && a.pluginKey === b.pluginKey && a.sourceId === b.sourceId
}

/** Routes through the sanctioned `plugins:invokeTaskSource` bridge only —
 *  never `PluginService.invokeTaskSource` directly (see plugin-task-source-invoker.ts). */
async function requestPluginTaskSourceItems(
  selection: SelectedPluginTaskSource,
  query: PluginTaskSourceQuery,
  scopeIds: string[]
): Promise<PluginTaskSourceResult<PluginTaskPage>> {
  const invoke = window.api?.plugins?.invokeTaskSource
  if (!invoke) {
    return { ok: false, code: 'unavailable', message: 'Plugin bridge is unavailable.' }
  }
  try {
    const result = await invoke({
      pluginKey: selection.pluginKey,
      sourceId: selection.sourceId,
      method: 'listItems',
      params: buildListQuery(query, scopeIds)
    })
    if (!result.ok) {
      return result
    }
    return { ok: true, data: pluginTaskPageSchema.parse(result.data) }
  } catch (error) {
    return {
      ok: false,
      code: 'unavailable',
      message: error instanceof Error ? error.message : String(error)
    }
  }
}

/** A status failure yields no chips rather than an error banner: the item load
 *  reports the same outage with its own code, and one outage must not read as
 *  two separate failures. */
async function requestPluginTaskSourceFilters(
  selection: SelectedPluginTaskSource
): Promise<PluginTaskSourceFilter[]> {
  const invoke = window.api?.plugins?.invokeTaskSource
  if (!invoke) {
    return []
  }
  try {
    const result = await invoke({
      pluginKey: selection.pluginKey,
      sourceId: selection.sourceId,
      method: 'status'
    })
    if (!result.ok) {
      return []
    }
    return pluginTaskSourceStatusSchema.parse(result.data).filters ?? []
  } catch {
    return []
  }
}

/** Unlike filters, a failure here is reported rather than swallowed: an empty
 *  scope list is a real answer ("this source has no projects") and must stay
 *  distinguishable from a call that never succeeded. */
async function requestPluginTaskSourceScopes(
  selection: SelectedPluginTaskSource
): Promise<PluginTaskSourceResult<PluginTaskScope[]>> {
  const invoke = window.api?.plugins?.invokeTaskSource
  if (!invoke) {
    return { ok: false, code: 'unavailable', message: 'Plugin bridge is unavailable.' }
  }
  try {
    const result = await invoke({
      pluginKey: selection.pluginKey,
      sourceId: selection.sourceId,
      method: 'listScopes'
    })
    if (!result.ok) {
      return result
    }
    return { ok: true, data: pluginTaskScopeListSchema.parse(result.data) }
  } catch (error) {
    return {
      ok: false,
      code: 'unavailable',
      message: error instanceof Error ? error.message : String(error)
    }
  }
}

export const createPluginTaskSourcesSlice: StateCreator<
  AppState,
  [],
  [],
  PluginTaskSourcesSlice
> = (set, get) => ({
  pluginTaskSources: [],
  selectedPluginTaskSource: null,
  pluginTaskSourceItems: [],
  pluginTaskSourceLoading: false,
  pluginTaskSourceError: null,
  pluginTaskSourceFilters: [],
  pluginTaskSourceQuery: UNFILTERED_QUERY,
  pluginTaskSourceScopes: [],
  pluginTaskSourceScopesLoading: false,
  pluginTaskSourceScopesError: null,
  selectedPluginTaskSourceScopeIds: ALL_SCOPES,

  setPluginTaskSources: (sources) => {
    set({ pluginTaskSources: sources })
  },

  selectPluginTaskSource: (selection) => {
    set({
      selectedPluginTaskSource: selection,
      pluginTaskSourceItems: [],
      pluginTaskSourceError: null,
      pluginTaskSourceLoading: false,
      pluginTaskSourceFilters: [],
      pluginTaskSourceQuery: UNFILTERED_QUERY,
      pluginTaskSourceScopes: [],
      pluginTaskSourceScopesLoading: false,
      pluginTaskSourceScopesError: null,
      selectedPluginTaskSourceScopeIds: ALL_SCOPES
    })
  },

  setPluginTaskSourceQuery: (query) => {
    set({ pluginTaskSourceQuery: query })
  },

  setPluginTaskSourceScopeIds: (scopeIds) => {
    set({ selectedPluginTaskSourceScopeIds: scopeIds })
  },

  loadPluginTaskSourceFilters: async () => {
    const selection = get().selectedPluginTaskSource
    if (!selection) {
      return
    }
    const filters = await requestPluginTaskSourceFilters(selection)
    if (!isSameSelection(get().selectedPluginTaskSource, selection)) {
      return
    }
    set({ pluginTaskSourceFilters: filters })
  },

  loadPluginTaskSourceScopes: async () => {
    const selection = get().selectedPluginTaskSource
    if (!selection) {
      return
    }
    set({ pluginTaskSourceScopesLoading: true })
    const result = await requestPluginTaskSourceScopes(selection)
    if (!isSameSelection(get().selectedPluginTaskSource, selection)) {
      return
    }
    if (result.ok) {
      set({
        pluginTaskSourceScopes: result.data,
        pluginTaskSourceScopesError: null,
        pluginTaskSourceScopesLoading: false
      })
    } else {
      set({
        pluginTaskSourceScopes: [],
        pluginTaskSourceScopesError: { code: result.code, message: result.message },
        pluginTaskSourceScopesLoading: false
      })
    }
  },

  loadPluginTaskSourceItems: async () => {
    const selection = get().selectedPluginTaskSource
    if (!selection) {
      return
    }
    const query = get().pluginTaskSourceQuery
    const scopeIds = get().selectedPluginTaskSourceScopeIds
    set({ pluginTaskSourceLoading: true })
    const result = await requestPluginTaskSourceItems(selection, query, scopeIds)
    // A stale response from a since-abandoned source, a since-replaced query, or
    // a since-replaced scope selection must never overwrite what the user is
    // looking at by the time it arrives.
    if (
      !isSameSelection(get().selectedPluginTaskSource, selection) ||
      get().pluginTaskSourceQuery !== query ||
      get().selectedPluginTaskSourceScopeIds !== scopeIds
    ) {
      return
    }
    if (result.ok) {
      set({
        pluginTaskSourceItems: result.data.items,
        pluginTaskSourceError: null,
        pluginTaskSourceLoading: false
      })
    } else {
      set({
        pluginTaskSourceError: { code: result.code, message: result.message },
        pluginTaskSourceLoading: false
      })
    }
  }
})
