import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { PluginHostListEntry } from '../../../../preload/api-types'
import { z } from 'zod'
import {
  pluginTaskCommentSchema,
  pluginTaskItemDetailSchema,
  pluginTaskItemSchema,
  pluginTaskItemTypeSchema,
  pluginTaskPageSchema,
  pluginTaskScopeSchema,
  pluginTaskSourceStatusSchema,
  type PluginTaskQuery,
  type PluginTaskSourceResult
} from '../../../../shared/plugins/plugin-task-source-contract'
import {
  invokePluginTaskSource,
  isSamePluginTaskSourceSelection
} from './plugin-task-source-bridge'
import {
  createPluginTaskSourceFacetOptionsAction,
  initialPluginTaskSourceFacetOptions
} from './plugin-task-source-facet-options'
import {
  createPluginTaskSourceSelectionActions,
  readPersistedPluginTaskSourceSelection,
  retainOfferedScopeIds
} from './plugin-task-source-selection-persistence'
import type {
  ContributedPluginTaskSource,
  PluginTaskSourceFacetOptions,
  PluginTaskSourceQuery,
  PluginTaskSourcesSlice
} from './plugin-task-sources-slice-contract'

export type {
  ContributedPluginTaskSource,
  PluginTaskCommentDraft,
  PluginTaskSourceFacetOptions,
  PluginTaskSourceFilter,
  PluginTaskSourceLoadError,
  PluginTaskSourceQuery,
  PluginTaskSourcesSlice,
  SelectedPluginTaskSource
} from './plugin-task-sources-slice-contract'

const PLUGIN_TASK_SOURCE_PAGE_SIZE = 50
const UNFILTERED_QUERY: PluginTaskSourceQuery = {
  search: null,
  filterId: null,
  facetSelections: {}
}
const ALL_SCOPES: string[] = []
const NO_SEEDED_FACETS: string[] = []

const pluginTaskScopeListSchema = z.array(pluginTaskScopeSchema)
const pluginTaskItemTypeListSchema = z.array(pluginTaskItemTypeSchema)
const pluginTaskCommentListSchema = z.array(pluginTaskCommentSchema)

const NO_SELECTION: PluginTaskSourceResult<never> = {
  ok: false,
  code: 'unavailable',
  message: 'No task source is selected.'
}

/** `filterId` and `facetSelections` are omitted rather than sent empty so a
 *  source that never declared either sees the exact request it saw before they
 *  existed. */
function buildListQuery(
  query: PluginTaskSourceQuery,
  scopeIds: string[],
  facetOptions: Record<string, PluginTaskSourceFacetOptions>
): PluginTaskQuery {
  // Only facets whose options have settled for the scope on screen are sent.
  // A scope change runs the items load in the same commit as the options load,
  // so an unsettled facet still holds the previous project's option ids, which
  // the source refuses outright rather than ignoring. Sending fewer facets
  // widens this one response; sending a retired id fails the whole list.
  const facetSelections = Object.fromEntries(
    Object.entries(query.facetSelections).filter(
      ([facetId]) => facetOptions[facetId]?.status === 'ready'
    )
  )
  const hasFacetSelections = Object.keys(facetSelections).length > 0
  return {
    scopeIds,
    search: query.search,
    cursor: null,
    limit: PLUGIN_TASK_SOURCE_PAGE_SIZE,
    ...(query.filterId ? { filterId: query.filterId } : {}),
    ...(hasFacetSelections ? { facetSelections } : {})
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
        ...(source.icon ? { icon: source.icon } : {}),
        ...(source.iconDataUrl ? { iconDataUrl: source.iconDataUrl } : {})
      }))
    )
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
  pluginTaskSourceFacets: [],
  pluginTaskSourceFacetOptions: {},
  pluginTaskSourceSeededFacetIds: NO_SEEDED_FACETS,
  pluginTaskSourceSupportsCreate: false,
  pluginTaskSourceSupportsComment: false,
  pluginTaskSourceQuery: UNFILTERED_QUERY,
  pluginTaskSourceScopes: [],
  pluginTaskSourceScopesLoading: false,
  pluginTaskSourceScopesError: null,
  selectedPluginTaskSourceScopeIds: ALL_SCOPES,
  pluginTaskSourceSelectionRestored: false,
  pluginTaskSourceRefreshing: false,

  setPluginTaskSources: (sources) => {
    set({ pluginTaskSources: sources })
  },

  // The saved selection is restored here rather than after the status probe, so
  // the first list request already carries it instead of loading the unfiltered
  // list and then reshuffling it.
  selectPluginTaskSource: (selection) => {
    const restored = selection
      ? readPersistedPluginTaskSourceSelection(get().settings, selection)
      : null
    set({
      selectedPluginTaskSource: selection,
      pluginTaskSourceItems: [],
      pluginTaskSourceError: null,
      pluginTaskSourceLoading: false,
      pluginTaskSourceFilters: [],
      pluginTaskSourceFacets: [],
      pluginTaskSourceFacetOptions: {},
      pluginTaskSourceSeededFacetIds: NO_SEEDED_FACETS,
      pluginTaskSourceSupportsCreate: false,
      pluginTaskSourceSupportsComment: false,
      pluginTaskSourceQuery: restored
        ? { ...UNFILTERED_QUERY, facetSelections: restored.facetSelections }
        : UNFILTERED_QUERY,
      pluginTaskSourceScopes: [],
      pluginTaskSourceScopesLoading: false,
      pluginTaskSourceScopesError: null,
      selectedPluginTaskSourceScopeIds: restored ? restored.scopeIds : ALL_SCOPES,
      pluginTaskSourceSelectionRestored: restored !== null,
      pluginTaskSourceRefreshing: false
    })
  },

  ...createPluginTaskSourceSelectionActions(set, get),

  // A status failure yields no chips and no create control rather than an error
  // banner: the item load reports the same outage with its own code, and one
  // outage must not read as two separate failures.
  loadPluginTaskSourceStatus: async () => {
    const selection = get().selectedPluginTaskSource
    if (!selection) {
      return
    }
    const result = await invokePluginTaskSource(selection, 'status', pluginTaskSourceStatusSchema)
    if (!isSamePluginTaskSourceSelection(get().selectedPluginTaskSource, selection)) {
      return
    }
    const facets = result.ok ? (result.data.facets ?? []) : []
    set({
      pluginTaskSourceFilters: result.ok ? (result.data.filters ?? []) : [],
      pluginTaskSourceFacets: facets,
      pluginTaskSourceFacetOptions: initialPluginTaskSourceFacetOptions(facets),
      pluginTaskSourceSupportsCreate: result.ok ? result.data.supports.create : false,
      pluginTaskSourceSupportsComment: result.ok ? result.data.supports.comment : false
    })
  },

  ...createPluginTaskSourceFacetOptionsAction(set, get),

  loadPluginTaskSourceScopes: async () => {
    const selection = get().selectedPluginTaskSource
    if (!selection) {
      return
    }
    set({ pluginTaskSourceScopesLoading: true })
    const result = await invokePluginTaskSource(selection, 'listScopes', pluginTaskScopeListSchema)
    if (!isSamePluginTaskSourceSelection(get().selectedPluginTaskSource, selection)) {
      return
    }
    if (result.ok) {
      // The settled scope list is the first chance to tell a restored project
      // that still exists from one this account can no longer see.
      const retainedScopeIds = retainOfferedScopeIds(
        get().selectedPluginTaskSourceScopeIds,
        result.data
      )
      set({
        pluginTaskSourceScopes: result.data,
        pluginTaskSourceScopesError: null,
        pluginTaskSourceScopesLoading: false
      })
      if (retainedScopeIds) {
        // Through the setter, not a raw set: it is the only writer that
        // persists, and a drop kept in memory alone is restored on the next
        // launch and dropped again, forever.
        get().setPluginTaskSourceScopeIds(retainedScopeIds)
        // Dropping a scope strands both loads already in flight: their stale
        // guards see a scope set that moved on and discard themselves, leaving
        // every facet on `loading` and — because the items guard returns
        // without clearing it — the list spinner on too. Reload both for the
        // scopes that survived rather than settling the ones that did not.
        await Promise.all([
          get().loadPluginTaskSourceItems(),
          get().loadPluginTaskSourceFacetOptions()
        ])
      }
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
    const result = await invokePluginTaskSource(
      selection,
      'listItems',
      pluginTaskPageSchema,
      buildListQuery(query, scopeIds, get().pluginTaskSourceFacetOptions)
    )
    // A stale response from a since-abandoned source, a since-replaced query, or
    // a since-replaced scope selection must never overwrite what the user is
    // looking at by the time it arrives.
    if (
      !isSamePluginTaskSourceSelection(get().selectedPluginTaskSource, selection) ||
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
  },

  refreshPluginTaskSource: async () => {
    if (get().pluginTaskSourceRefreshing) {
      return
    }
    set({ pluginTaskSourceRefreshing: true })
    try {
      // Both calls read the query/scopeIds/selection already in the store, so
      // the refresh carries the user's current filter, search and projects
      // rather than resetting to defaults. Each keeps its own stale-response
      // guard, so a selection change or a newer edit mid-refresh still wins.
      await Promise.all([
        get().loadPluginTaskSourceItems(),
        get().loadPluginTaskSourceScopes(),
        get().loadPluginTaskSourceFacetOptions()
      ])
    } finally {
      set({ pluginTaskSourceRefreshing: false })
    }
  },

  listPluginTaskSourceItemTypes: async (scopeId) => {
    const selection = get().selectedPluginTaskSource
    if (!selection) {
      return NO_SELECTION
    }
    return invokePluginTaskSource(selection, 'listItemTypes', pluginTaskItemTypeListSchema, {
      scopeId
    })
  },

  createPluginTaskSourceItem: async (input) => {
    const selection = get().selectedPluginTaskSource
    if (!selection) {
      return NO_SELECTION
    }
    return invokePluginTaskSource(selection, 'createItem', pluginTaskItemSchema, input)
  },

  getPluginTaskSourceItem: async (itemId) => {
    const selection = get().selectedPluginTaskSource
    if (!selection) {
      return NO_SELECTION
    }
    return invokePluginTaskSource(selection, 'getItem', pluginTaskItemDetailSchema, { id: itemId })
  },

  listPluginTaskSourceComments: async (itemId) => {
    const selection = get().selectedPluginTaskSource
    if (!selection) {
      return NO_SELECTION
    }
    return invokePluginTaskSource(selection, 'listComments', pluginTaskCommentListSchema, {
      id: itemId
    })
  },

  addPluginTaskSourceComment: async ({ itemId, body }) => {
    const selection = get().selectedPluginTaskSource
    if (!selection) {
      return NO_SELECTION
    }
    return invokePluginTaskSource(selection, 'addComment', pluginTaskCommentSchema, {
      id: itemId,
      body
    })
  }
})
