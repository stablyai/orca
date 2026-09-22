import type { PluginTaskFacetOption } from '../../../../shared/plugins/plugin-task-source-contract'
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

/** A shared spelling, not a contract field: a source that wants its assignee
 *  facet to open on the signed-in user names the facet `assignee` and offers
 *  `@me` among its options. Nothing else in core reads either id, and a source
 *  that spells them differently simply opens unfiltered. */
export const ASSIGNEE_FACET_ID = 'assignee'
export const ME_ASSIGNEE_OPTION_ID = '@me'

/** Null whenever there is nothing to seed: another facet, a facet the user has
 *  already narrowed, or options carrying no me-option — an option list is per
 *  scope, so the same facet may offer one under one project and not another. */
export function applyMeAssigneeSeed(
  query: PluginTaskSourceQuery,
  facetId: string,
  options: readonly PluginTaskFacetOption[]
): PluginTaskSourceQuery | null {
  if (facetId !== ASSIGNEE_FACET_ID || query.facetSelections[facetId] !== undefined) {
    return null
  }
  if (!options.some((option) => option.id === ME_ASSIGNEE_OPTION_ID)) {
    return null
  }
  return {
    ...query,
    facetSelections: { ...query.facetSelections, [facetId]: [ME_ASSIGNEE_OPTION_ID] }
  }
}
