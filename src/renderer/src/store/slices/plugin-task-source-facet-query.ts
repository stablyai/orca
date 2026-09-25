import type {
  PluginTaskFacet,
  PluginTaskFacetOption
} from '../../../../shared/plugins/plugin-task-source-contract'
import type { PluginTaskSourceQuery } from './plugin-task-sources-slice-contract'

/**
 * How a settled option list changes the list query: what it may seed, and what
 * it retires. Both run only against options the source actually resolved for
 * the scope on screen.
 */

/** Null when the selection already holds only options this scope offers. A
 *  sprint or state belongs to the project it came from, and a source refuses an
 *  option id it cannot resolve there, so a stale id must go rather than reach
 *  the query as a failed request. */
export function pruneFacetSelectionToOptions(
  query: PluginTaskSourceQuery,
  facetId: string,
  options: readonly PluginTaskFacetOption[]
): PluginTaskSourceQuery | null {
  const selected = query.facetSelections[facetId]
  if (selected === undefined) {
    return null
  }
  const offered = new Set(options.map((option) => option.id))
  const retained = selected.filter((optionId) => offered.has(optionId))
  if (retained.length === selected.length) {
    return null
  }
  const facetSelections = { ...query.facetSelections }
  if (retained.length === 0) {
    delete facetSelections[facetId]
  } else {
    facetSelections[facetId] = retained
  }
  return { ...query, facetSelections }
}

/** Null whenever there is nothing to seed: a facet declaring no default, one the
 *  user has already narrowed, or a declaration naming only options this scope
 *  does not offer. A declared id the scope cannot resolve is dropped rather than
 *  refused — an option list is per scope, and a source may offer a default under
 *  one project and not another — so what survives still seeds and the list
 *  renders either way. */
export function applyDeclaredFacetDefault(
  query: PluginTaskSourceQuery,
  facet: PluginTaskFacet,
  options: readonly PluginTaskFacetOption[]
): PluginTaskSourceQuery | null {
  if (query.facetSelections[facet.id] !== undefined) {
    return null
  }
  const offered = new Set(options.map((option) => option.id))
  const seeded = (facet.defaultOptionIds ?? []).filter((optionId) => offered.has(optionId))
  if (seeded.length === 0) {
    return null
  }
  return { ...query, facetSelections: { ...query.facetSelections, [facet.id]: seeded } }
}
