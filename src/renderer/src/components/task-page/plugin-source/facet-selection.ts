import { translate } from '@/i18n/i18n'
import type {
  PluginTaskFacet,
  PluginTaskFacetOption
} from '../../../../../shared/plugins/plugin-task-source-contract'

/** A cleared facet drops its key rather than holding an empty array: an empty
 *  array is a selection the source would have to tell apart from no selection
 *  at all, and the contract gives it no way to. */
function withFacetOptionIds(
  selections: Readonly<Record<string, string[]>>,
  facetId: string,
  optionIds: readonly string[]
): Record<string, string[]> {
  const next = { ...selections }
  if (optionIds.length === 0) {
    delete next[facetId]
    return next
  }
  next[facetId] = [...optionIds]
  return next
}

/** A `single` facet replaces its selection; a `multi` one accumulates. Pressing
 *  the chosen option of either clears it. */
export function togglePluginTaskFacetOption(
  selections: Readonly<Record<string, string[]>>,
  facet: PluginTaskFacet,
  optionId: string
): Record<string, string[]> {
  const current = selections[facet.id] ?? []
  if (current.includes(optionId)) {
    return withFacetOptionIds(
      selections,
      facet.id,
      current.filter((id) => id !== optionId)
    )
  }
  return withFacetOptionIds(
    selections,
    facet.id,
    facet.kind === 'single' ? [optionId] : [...current, optionId]
  )
}

export function clearPluginTaskFacet(
  selections: Readonly<Record<string, string[]>>,
  facetId: string
): Record<string, string[]> {
  return withFacetOptionIds(selections, facetId, [])
}

/** Matches on `label` alone — an option id is a provider-native string the user
 *  never saw. */
export function filterPluginTaskFacetOptions(
  options: readonly PluginTaskFacetOption[],
  query: string
): PluginTaskFacetOption[] {
  const needle = query.trim().toLowerCase()
  if (needle === '') {
    return [...options]
  }
  return options.filter((option) => option.label.toLowerCase().includes(needle))
}

/** Names the narrowing on the closed control, so an active facet is readable
 *  without opening it. An id with no matching option is counted but never shown
 *  raw: options are per scope, so a selection can outlive the option naming it. */
export function describePluginTaskFacetSelection(
  facet: PluginTaskFacet,
  options: readonly PluginTaskFacetOption[],
  selectedOptionIds: readonly string[]
): string {
  if (selectedOptionIds.length === 0) {
    return facet.label
  }
  if (selectedOptionIds.length === 1) {
    const only = options.find((option) => option.id === selectedOptionIds[0])
    if (only) {
      return translate(
        'auto.components.TaskPage.pluginTaskSourceFacetOne',
        '{{value0}}: {{value1}}',
        {
          value0: facet.label,
          value1: only.label
        }
      )
    }
  }
  return translate(
    'auto.components.TaskPage.pluginTaskSourceFacetMany',
    '{{value0}}: {{value1}} selected',
    { value0: facet.label, value1: selectedOptionIds.length }
  )
}
