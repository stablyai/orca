import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type {
  PluginTaskItem,
  PluginTaskScope,
  PluginTaskSourceErrorCode
} from '../../../../shared/plugins/plugin-task-source-contract'

/** A plugin's contribution to the Tasks source bar. */
export type ContributedPluginTaskSource = {
  pluginKey: string
  sourceId: string
  title: string
  icon?: string
}

export type SelectedPluginTaskSource = {
  pluginKey: string
  sourceId: string
}

/** Keeps the closed error taxonomy visible in state, so "token expired" and
 *  "worker died" stay distinguishable instead of collapsing into one string. */
export type PluginTaskSourceLoadError = {
  code: PluginTaskSourceErrorCode
  message: string
}

/** A preset the source declares in `status().filters`, rendered as a chip. */
export type PluginTaskSourceFilter = {
  id: string
  label: string
}

/** What the user has narrowed the list to. Reset whenever the selected source
 *  changes: a filter id is that source's own vocabulary and means nothing to
 *  the next one. */
export type PluginTaskSourceQuery = {
  search: string | null
  filterId: string | null
}

export type PluginTaskSourcesSlice = {
  /** Populated by `setPluginTaskSources` from the plugin list; this slice
   *  never fetches plugins itself — that stays owned by `usePluginPanelsStore`. */
  pluginTaskSources: ContributedPluginTaskSource[]
  selectedPluginTaskSource: SelectedPluginTaskSource | null
  pluginTaskSourceItems: PluginTaskItem[]
  pluginTaskSourceLoading: boolean
  pluginTaskSourceError: PluginTaskSourceLoadError | null
  pluginTaskSourceFilters: PluginTaskSourceFilter[]
  pluginTaskSourceQuery: PluginTaskSourceQuery
  /** Projects/boards the source can be narrowed to, as `listScopes` named
   *  them. Core never re-derives or reformats `name`. */
  pluginTaskSourceScopes: PluginTaskScope[]
  pluginTaskSourceScopesLoading: boolean
  /** Separate from `pluginTaskSourceError` so a failed `listScopes` cannot be
   *  rendered as a source with no projects. */
  pluginTaskSourceScopesError: PluginTaskSourceLoadError | null
  /** Empty means every scope, which is also what the wire contract means by an
   *  empty `scopeIds`. */
  selectedPluginTaskSourceScopeIds: string[]

  setPluginTaskSources: (sources: ContributedPluginTaskSource[]) => void
  selectPluginTaskSource: (selection: SelectedPluginTaskSource | null) => void
  setPluginTaskSourceQuery: (query: PluginTaskSourceQuery) => void
  setPluginTaskSourceScopeIds: (scopeIds: string[]) => void
  loadPluginTaskSourceFilters: () => Promise<void>
  loadPluginTaskSourceScopes: () => Promise<void>
  loadPluginTaskSourceItems: () => Promise<void>
}

type PluginTaskSourcesStateCreator = StateCreator<AppState, [], [], PluginTaskSourcesSlice>

export type PluginTaskSourcesSliceSet = Parameters<PluginTaskSourcesStateCreator>[0]
export type PluginTaskSourcesSliceGet = Parameters<PluginTaskSourcesStateCreator>[1]
