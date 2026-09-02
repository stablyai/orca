import type { PaletteFilterOption } from './palette-filter-options'

/** Fixed row height for the virtualized options list. */
export const FILTER_OPTION_ROW_HEIGHT = 32

/** Viewport height of the options scroller. */
export const FILTER_OPTION_LIST_MAX_HEIGHT = 280

/**
 * Beyond this, pinning every selected row would bury unselected options.
 * The UI collapses them into a summary; chips still manage individual removals.
 */
export const FILTER_OPTION_MAX_PINNED_SELECTED = 12

export type FilterOptionRankMode = 'registry' | 'popularity'

export type RankedPaletteFilterOptions = {
  /** Selected (when not collapsed) then unselected — full list; UI virtualizes. */
  ordered: readonly PaletteFilterOption[]
  selectedCount: number
  unselectedCount: number
  /** Unselected match ids in list order — used by "Select all matching". */
  unselectedIds: readonly string[]
  /** Selected rows omitted from ordered because there were too many to pin. */
  selectedCollapsed: boolean
}

export function buildPaletteFilterOptionSearchText(label: string, detail: string): string {
  return detail ? `${label} ${detail}`.toLowerCase() : label.toLowerCase()
}

function compareByPopularity(a: PaletteFilterOption, b: PaletteFilterOption): number {
  const countDelta = b.count - a.count
  if (countDelta !== 0) {
    return countDelta
  }
  return a.label.localeCompare(b.label) || a.id.localeCompare(b.id)
}

/**
 * Filters by pre-normalized searchText, pins selected matches first so they stay
 * undoable, and ranks the rest for discovery (popularity) or stable registry order
 * (hosts: local → SSH). No render cap — the list is virtualized.
 */
export function rankPaletteFilterOptions({
  options,
  selectedIds,
  query,
  rankMode
}: {
  options: readonly PaletteFilterOption[]
  selectedIds: ReadonlySet<string>
  /** Already trimmed + lowercased. */
  query: string
  rankMode: FilterOptionRankMode
}): RankedPaletteFilterOptions {
  const selected: PaletteFilterOption[] = []
  const unselected: PaletteFilterOption[] = []
  for (const option of options) {
    const isSelected = selectedIds.has(option.id)
    // Why: selected rows stay visible past a search mismatch so they can still
    // be unchecked without clearing the whole field or hunting through chips.
    if (!isSelected && query && !option.searchText.includes(query)) {
      continue
    }
    if (isSelected) {
      selected.push(option)
    } else {
      unselected.push(option)
    }
  }

  if (rankMode === 'popularity') {
    selected.sort(compareByPopularity)
    unselected.sort(compareByPopularity)
  }
  // registry: keep input order within each partition (hosts stay local-first)

  const selectedCollapsed = selected.length > FILTER_OPTION_MAX_PINNED_SELECTED
  return {
    ordered: selectedCollapsed || selected.length === 0 ? unselected : [...selected, ...unselected],
    selectedCount: selected.length,
    unselectedCount: unselected.length,
    unselectedIds: unselected.map((option) => option.id),
    selectedCollapsed
  }
}
