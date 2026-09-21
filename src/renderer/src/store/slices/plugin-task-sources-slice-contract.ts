import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type {
  PluginTaskComment,
  PluginTaskCreate,
  PluginTaskItem,
  PluginTaskItemDetail,
  PluginTaskItemType,
  PluginTaskScope,
  PluginTaskSourceErrorCode,
  PluginTaskSourceResult
} from '../../../../shared/plugins/plugin-task-source-contract'

/** A plugin's contribution to the Tasks source bar. */
export type ContributedPluginTaskSource = {
  pluginKey: string
  sourceId: string
  title: string
  /** As the plugin declared it: a Lucide token, or its own `.svg` path. */
  icon?: string
  /** The host-validated SVG, already encoded. Absent whenever the declared
   *  icon is a Lucide token or the asset failed validation. */
  iconDataUrl?: string
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
  /** Straight from `status().supports.create`. False until the probe answers,
   *  so a source is never offered a create control it did not declare. */
  pluginTaskSourceSupportsCreate: boolean
  /** Straight from `status().supports.comment`. False until the probe answers,
   *  so a source that cannot post is never shown a composer. */
  pluginTaskSourceSupportsComment: boolean
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
  /** Guards the refresh button, not the individual loads: it stays true across
   *  both the item and scope reload so a second click cannot start a duplicate. */
  pluginTaskSourceRefreshing: boolean

  setPluginTaskSources: (sources: ContributedPluginTaskSource[]) => void
  selectPluginTaskSource: (selection: SelectedPluginTaskSource | null) => void
  setPluginTaskSourceQuery: (query: PluginTaskSourceQuery) => void
  setPluginTaskSourceScopeIds: (scopeIds: string[]) => void
  /** One status probe feeds both the chip row and the create control. */
  loadPluginTaskSourceStatus: () => Promise<void>
  loadPluginTaskSourceScopes: () => Promise<void>
  loadPluginTaskSourceItems: () => Promise<void>
  /** Re-runs `listItems` and `listScopes` with the selection already in the
   *  store, so a chip, a search, or a picked project survives the refresh. */
  refreshPluginTaskSource: () => Promise<void>
  /** Scope-bound, never cached: the creatable types differ per project. */
  listPluginTaskSourceItemTypes: (
    scopeId: string
  ) => Promise<PluginTaskSourceResult<PluginTaskItemType[]>>
  /** Returns the envelope rather than setting state: the caller decides
   *  whether a failure belongs in its own form or in the page banner. */
  createPluginTaskSourceItem: (
    input: PluginTaskCreate
  ) => Promise<PluginTaskSourceResult<PluginTaskItem>>
  /** Fetched when the detail panel opens; list rows deliberately carry no body. */
  getPluginTaskSourceItem: (itemId: string) => Promise<PluginTaskSourceResult<PluginTaskItemDetail>>
  /** Separate envelope from `getPluginTaskSourceItem` so a source that answers
   *  the body but not its comments still shows the body. */
  listPluginTaskSourceComments: (
    itemId: string
  ) => Promise<PluginTaskSourceResult<PluginTaskComment[]>>
  /** Returns the envelope rather than setting state: a rejected post belongs
   *  beside the composer that still holds the typed body. */
  addPluginTaskSourceComment: (
    input: PluginTaskCommentDraft
  ) => Promise<PluginTaskSourceResult<PluginTaskComment>>
}

/** Named rather than two positional strings: `(itemId, body)` are the same
 *  type, so a swapped pair would post the id as the comment. */
export type PluginTaskCommentDraft = {
  itemId: string
  body: string
}

type PluginTaskSourcesStateCreator = StateCreator<AppState, [], [], PluginTaskSourcesSlice>

export type PluginTaskSourcesSliceSet = Parameters<PluginTaskSourcesStateCreator>[0]
export type PluginTaskSourcesSliceGet = Parameters<PluginTaskSourcesStateCreator>[1]
