import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { PluginTaskScope } from '../../../../shared/plugins/plugin-task-source-contract'
import {
  haveSamePluginTaskSourceFacetSelections,
  haveSamePluginTaskSourceIds,
  pluginTaskSourceSelectionKey,
  type PersistedPluginTaskSourceSelection
} from '../../../../shared/plugins/plugin-task-source-selection-persistence'
import type {
  PluginTaskSourcesSlice,
  PluginTaskSourcesSliceGet,
  PluginTaskSourcesSliceSet,
  SelectedPluginTaskSource
} from './plugin-task-sources-slice-contract'

/**
 * The narrowing the user edits, and its saved copy. Keyed per source, so two
 * contributed sources never share a selection.
 */

/** Null when this source has no saved entry, which is the only state a facet's
 *  declared default may seed. */
export function readPersistedPluginTaskSourceSelection(
  settings: GlobalSettings | null,
  selection: SelectedPluginTaskSource
): PersistedPluginTaskSourceSelection | null {
  return settings?.pluginTaskSourceSelections[pluginTaskSourceSelectionKey(selection)] ?? null
}

/** Both setters save, and neither saves what has not changed: a re-render or a
 *  keystroke in the search box must not reach settings. */
export function createPluginTaskSourceSelectionActions(
  set: PluginTaskSourcesSliceSet,
  get: PluginTaskSourcesSliceGet
): Pick<PluginTaskSourcesSlice, 'setPluginTaskSourceQuery' | 'setPluginTaskSourceScopeIds'> {
  return {
    // Only the facet bar is saved, not the search text or the active chip.
    setPluginTaskSourceQuery: (query) => {
      const previous = get().pluginTaskSourceQuery
      set({ pluginTaskSourceQuery: query })
      if (
        haveSamePluginTaskSourceFacetSelections(previous.facetSelections, query.facetSelections)
      ) {
        return
      }
      void persistPluginTaskSourceSelection(get, {
        facetSelections: query.facetSelections,
        scopeIds: get().selectedPluginTaskSourceScopeIds
      })
    },

    setPluginTaskSourceScopeIds: (scopeIds) => {
      const previous = get().selectedPluginTaskSourceScopeIds
      set({ selectedPluginTaskSourceScopeIds: scopeIds })
      if (haveSamePluginTaskSourceIds(previous, scopeIds)) {
        return
      }
      void persistPluginTaskSourceSelection(get, {
        facetSelections: get().pluginTaskSourceQuery.facetSelections,
        scopeIds
      })
    }
  }
}

/** Silent when settings have not loaded: there is nothing to merge the entry
 *  into, and a failed save must never take the filter change off screen. */
async function persistPluginTaskSourceSelection(
  get: PluginTaskSourcesSliceGet,
  entry: PersistedPluginTaskSourceSelection
): Promise<void> {
  const selection = get().selectedPluginTaskSource
  const settings = get().settings
  if (!selection || !settings) {
    return
  }
  await get().updateSettings({
    pluginTaskSourceSelections: {
      ...settings.pluginTaskSourceSelections,
      [pluginTaskSourceSelectionKey(selection)]: entry
    }
  })
}

/** Null when every id is still offered. A selected project the source no longer
 *  lists — deleted, or no longer visible to this account — would otherwise leave
 *  the list filtered to something the user cannot see or clear; dropping the
 *  last one leaves the empty selection the source reads as its own default. */
export function retainOfferedScopeIds(
  scopeIds: readonly string[],
  scopes: readonly PluginTaskScope[]
): string[] | null {
  if (scopeIds.length === 0) {
    return null
  }
  const offered = new Set(scopes.map((scope) => scope.id))
  const retained = scopeIds.filter((scopeId) => offered.has(scopeId))
  return retained.length === scopeIds.length ? null : retained
}
