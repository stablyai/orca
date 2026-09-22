import { z } from 'zod'
import {
  pluginTaskFacetOptionSchema,
  type PluginTaskFacet,
  type PluginTaskFacetOption
} from '../../../../shared/plugins/plugin-task-source-contract'
import {
  invokePluginTaskSource,
  isSamePluginTaskSourceSelection
} from './plugin-task-source-bridge'
import { applyMeAssigneeSeed, pruneFacetSelectionToOptions } from './plugin-task-source-facet-query'
import type {
  PluginTaskSourceFacetOptions,
  PluginTaskSourcesSlice,
  PluginTaskSourcesSliceGet,
  PluginTaskSourcesSliceSet,
  SelectedPluginTaskSource
} from './plugin-task-sources-slice-contract'

const pluginTaskFacetOptionListSchema = z.array(pluginTaskFacetOptionSchema)

function declaredOptions(facet: PluginTaskFacet): PluginTaskFacetOption[] {
  return facet.options ?? []
}

/** A static facet is already answered by its declaration, so only a `dynamic`
 *  one starts out pending — the rest must never flash a spinner. */
export function initialPluginTaskSourceFacetOptions(
  facets: readonly PluginTaskFacet[]
): Record<string, PluginTaskSourceFacetOptions> {
  const initial: Record<string, PluginTaskSourceFacetOptions> = {}
  for (const facet of facets) {
    initial[facet.id] = facet.dynamic
      ? { status: 'loading' }
      : { status: 'ready', options: declaredOptions(facet) }
  }
  return initial
}

/** Reports each facet as it settles rather than when the slowest one does, so a
 *  fast facet is usable while another is still in flight. */
async function fetchFacetOptions({
  selection,
  facets,
  scopeIds,
  onFacetSettled
}: {
  selection: SelectedPluginTaskSource
  facets: readonly PluginTaskFacet[]
  scopeIds: readonly string[]
  onFacetSettled: (facetId: string, options: PluginTaskSourceFacetOptions) => void
}): Promise<void> {
  await Promise.all(
    facets.map(async (facet) => {
      if (!facet.dynamic) {
        onFacetSettled(facet.id, { status: 'ready', options: declaredOptions(facet) })
        return
      }
      const result = await invokePluginTaskSource(
        selection,
        'listFacetOptions',
        pluginTaskFacetOptionListSchema,
        { facetId: facet.id, scopeIds: [...scopeIds] }
      )
      onFacetSettled(
        facet.id,
        result.ok
          ? { status: 'ready', options: result.data }
          : { status: 'failed', error: { code: result.code, message: result.message } }
      )
    })
  )
}

export function createPluginTaskSourceFacetOptionsAction(
  set: PluginTaskSourcesSliceSet,
  get: PluginTaskSourcesSliceGet
): Pick<PluginTaskSourcesSlice, 'loadPluginTaskSourceFacetOptions'> {
  return {
    loadPluginTaskSourceFacetOptions: async () => {
      const selection = get().selectedPluginTaskSource
      const facets = get().pluginTaskSourceFacets
      if (!selection || facets.length === 0) {
        return
      }
      const scopeIds = get().selectedPluginTaskSourceScopeIds
      set({ pluginTaskSourceFacetOptions: initialPluginTaskSourceFacetOptions(facets) })
      await fetchFacetOptions({
        selection,
        facets,
        scopeIds,
        onFacetSettled: (facetId, options) => {
          // A facet that settles after the user moved on describes a scope or a
          // source no longer on screen, so it is dropped rather than shown.
          if (
            !isSamePluginTaskSourceSelection(get().selectedPluginTaskSource, selection) ||
            get().selectedPluginTaskSourceScopeIds !== scopeIds
          ) {
            return
          }
          set({
            pluginTaskSourceFacetOptions: {
              ...get().pluginTaskSourceFacetOptions,
              [facetId]: options
            }
          })
          if (options.status !== 'ready') {
            return
          }
          const pruned = pruneFacetSelectionToOptions(
            get().pluginTaskSourceQuery,
            facetId,
            options.options
          )
          if (pruned) {
            set({ pluginTaskSourceQuery: pruned })
          }
          if (get().pluginTaskSourceAssigneeSeeded) {
            return
          }
          const seeded = applyMeAssigneeSeed(get().pluginTaskSourceQuery, facetId, options.options)
          if (seeded) {
            set({ pluginTaskSourceQuery: seeded, pluginTaskSourceAssigneeSeeded: true })
          }
        }
      })
    }
  }
}
