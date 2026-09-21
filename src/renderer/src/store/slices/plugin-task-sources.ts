import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { PluginHostListEntry } from '../../../../preload/api-types'
import {
  pluginTaskPageSchema,
  type PluginTaskPage,
  type PluginTaskQuery,
  type PluginTaskSourceResult
} from '../../../../shared/plugins/plugin-task-source-contract'
import type {
  ContributedPluginTaskSource,
  PluginTaskSourcesSlice,
  SelectedPluginTaskSource
} from './plugin-task-sources-slice-contract'

export type {
  ContributedPluginTaskSource,
  PluginTaskSourceLoadError,
  PluginTaskSourcesSlice,
  SelectedPluginTaskSource
} from './plugin-task-sources-slice-contract'

const PLUGIN_TASK_SOURCE_LIST_QUERY: PluginTaskQuery = {
  scopeIds: [],
  search: null,
  cursor: null,
  limit: 50
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

function isSameSelection(
  a: SelectedPluginTaskSource | null,
  b: SelectedPluginTaskSource
): boolean {
  return a !== null && a.pluginKey === b.pluginKey && a.sourceId === b.sourceId
}

/** Routes through the sanctioned `plugins:invokeTaskSource` bridge only —
 *  never `PluginService.invokeTaskSource` directly (see plugin-task-source-invoker.ts). */
async function requestPluginTaskSourceItems(
  selection: SelectedPluginTaskSource
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
      params: PLUGIN_TASK_SOURCE_LIST_QUERY
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

  setPluginTaskSources: (sources) => {
    set({ pluginTaskSources: sources })
  },

  selectPluginTaskSource: (selection) => {
    set({
      selectedPluginTaskSource: selection,
      pluginTaskSourceItems: [],
      pluginTaskSourceError: null,
      pluginTaskSourceLoading: false
    })
  },

  loadPluginTaskSourceItems: async () => {
    const selection = get().selectedPluginTaskSource
    if (!selection) {
      return
    }
    set({ pluginTaskSourceLoading: true })
    const result = await requestPluginTaskSourceItems(selection)
    // A stale response from a since-abandoned source must never overwrite
    // whatever the user has selected by the time it arrives.
    if (!isSameSelection(get().selectedPluginTaskSource, selection)) {
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
