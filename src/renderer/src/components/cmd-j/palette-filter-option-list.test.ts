import { describe, expect, it } from 'vitest'
import {
  buildPaletteFilterOptionSearchText,
  rankPaletteFilterOptions
} from './palette-filter-option-list'
import type { PaletteFilterOption } from './palette-filter-options'

const option = (id: string, label: string, count: number, detail = ''): PaletteFilterOption => ({
  id,
  label,
  detail,
  count,
  searchText: buildPaletteFilterOptionSearchText(label, detail)
})

describe('rankPaletteFilterOptions', () => {
  const options = [
    option('a', 'Alpha', 1),
    option('b', 'Beta', 5),
    option('c', 'Gamma', 3),
    option('d', 'Delta Host', 2, 'ssh')
  ]

  it('keeps selected rows visible even when they miss the query text', () => {
    // Selected rows must remain undoable after a search that would otherwise hide them.
    const ranked = rankPaletteFilterOptions({
      options,
      selectedIds: new Set(['a']),
      query: 'beta',
      rankMode: 'popularity'
    })

    expect(ranked.ordered.map((row) => row.id)).toEqual(['a', 'b'])
    expect(ranked.selectedCollapsed).toBe(false)
  })
})
