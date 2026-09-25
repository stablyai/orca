import { PLUGIN_TASK_FACETS_MAX, PLUGIN_TASK_PAGE_LIMIT } from './plugin-task-source-contract'

/**
 * What the user left a contributed task source narrowed to, kept in global
 * settings so reopening Orca restores the filter bar rather than re-deriving it.
 */

const ID_MAX = 512
const SCOPE_IDS_MAX = 64

export type PersistedPluginTaskSourceSelection = {
  /** Chosen option ids per declared facet id. A cleared facet is absent rather
   *  than held as an empty array, matching what the wire contract accepts. */
  facetSelections: Record<string, string[]>
  /** Empty means every scope, which is what the contract means by it too. */
  scopeIds: string[]
}

/** A qualified plugin key (`publisher.id`) holds no colon, so no two sources
 *  can share a key. */
export function pluginTaskSourceSelectionKey(selection: {
  pluginKey: string
  sourceId: string
}): string {
  return `${selection.pluginKey}:${selection.sourceId}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= ID_MAX
}

function normalizeIds(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) {
    return []
  }
  return [...new Set(value.filter(isId))].slice(0, max)
}

function normalizeFacetSelections(value: unknown): Record<string, string[]> {
  if (!isRecord(value)) {
    return {}
  }
  const selections: Record<string, string[]> = {}
  for (const [facetId, optionIds] of Object.entries(value)) {
    if (!isId(facetId) || Object.keys(selections).length >= PLUGIN_TASK_FACETS_MAX) {
      continue
    }
    const retained = normalizeIds(optionIds, PLUGIN_TASK_PAGE_LIMIT)
    if (retained.length > 0) {
      selections[facetId] = retained
    }
  }
  return selections
}

/** Bounded the way `pluginTaskQuerySchema` bounds the same values: a restored
 *  selection goes straight into a `listItems` request, so a hand-edited settings
 *  file must not be able to build one the source would reject.
 *
 *  An entry that normalizes to nothing selected is still kept: "the user cleared
 *  every facet" and "this source was never opened" have to stay distinguishable,
 *  because only the second may apply a facet's declared default. */
export function normalizePluginTaskSourceSelections(
  value: unknown
): Record<string, PersistedPluginTaskSourceSelection> {
  if (!isRecord(value)) {
    return {}
  }
  const selections: Record<string, PersistedPluginTaskSourceSelection> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (!isId(key) || !isRecord(entry)) {
      continue
    }
    selections[key] = {
      facetSelections: normalizeFacetSelections(entry.facetSelections),
      scopeIds: normalizeIds(entry.scopeIds, SCOPE_IDS_MAX)
    }
  }
  return selections
}

export function haveSamePluginTaskSourceFacetSelections(
  a: Readonly<Record<string, readonly string[]>>,
  b: Readonly<Record<string, readonly string[]>>
): boolean {
  const facetIds = Object.keys(a)
  if (facetIds.length !== Object.keys(b).length) {
    return false
  }
  return facetIds.every((facetId) => haveSamePluginTaskSourceIds(a[facetId] ?? [], b[facetId]))
}

export function haveSamePluginTaskSourceIds(
  a: readonly string[],
  b: readonly string[] | undefined
): boolean {
  return b !== undefined && a.length === b.length && a.every((id, index) => id === b[index])
}
