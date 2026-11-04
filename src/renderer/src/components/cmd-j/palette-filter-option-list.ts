import type { PaletteFilterOption } from './palette-filter-options'

export const FILTER_OPTION_ROW_HEIGHT = 32

export const FILTER_OPTION_LIST_MAX_HEIGHT = 280

/** Collapse large selected groups so unselected options remain discoverable; chips still remove individual selections. */
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

/** Keep selected rows undoable across search mismatches; rank the rest by popularity or registry order without capping the virtualized list. */
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
    // Selected rows must stay reachable for unchecking even when they miss the query.
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

  const selectedCollapsed = selected.length > FILTER_OPTION_MAX_PINNED_SELECTED
  return {
    ordered: selectedCollapsed || selected.length === 0 ? unselected : [...selected, ...unselected],
    selectedCount: selected.length,
    unselectedCount: unselected.length,
    unselectedIds: unselected.map((option) => option.id),
    selectedCollapsed
  }
}
