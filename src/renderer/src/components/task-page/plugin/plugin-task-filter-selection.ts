import type { PluginTaskFilter } from '../../../../../shared/plugins/plugin-task-source'

function isOffered(filter: PluginTaskFilter | undefined, value: string): boolean {
  return filter?.options.some((option) => option.value === value) ?? false
}

// Why: a remembered value the source no longer offers would render an empty picker.
export function selectedFilterValue(
  filter: PluginTaskFilter,
  selected: string | undefined
): string {
  if (selected !== undefined && isOffered(filter, selected)) {
    return selected
  }
  return filter.defaultValue ?? filter.options[0]?.value ?? ''
}

/**
 * Drops selections the source no longer offers, so the request and the saved view
 * match the pickers, which show the default for them. Returns `selection` when nothing is stale.
 */
export function reconcileFilterSelection(
  selection: Record<string, string>,
  offered: readonly PluginTaskFilter[]
): Record<string, string> {
  const byId = new Map(offered.map((filter) => [filter.id, filter]))
  const kept = Object.entries(selection).filter(([id, value]) => isOffered(byId.get(id), value))
  return kept.length === Object.keys(selection).length ? selection : Object.fromEntries(kept)
}
