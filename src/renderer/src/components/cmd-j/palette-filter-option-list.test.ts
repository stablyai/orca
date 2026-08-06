import { describe, expect, it } from 'vitest'
import {
  buildPaletteFilterOptionSearchText,
  FILTER_OPTION_MAX_PINNED_SELECTED,
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

describe('buildPaletteFilterOptionSearchText', () => {
  it('lowercases label and detail once for cheap includes checks', () => {
    expect(buildPaletteFilterOptionSearchText('Acme', 'SSH host')).toBe('acme ssh host')
    expect(buildPaletteFilterOptionSearchText('Local', '')).toBe('local')
  })
})

describe('rankPaletteFilterOptions', () => {
  const options = [
    option('a', 'Alpha', 1),
    option('b', 'Beta', 5),
    option('c', 'Gamma', 3),
    option('d', 'Delta Host', 2, 'ssh')
  ]

  it('pins selected matches first and ranks the rest by popularity', () => {
    const ranked = rankPaletteFilterOptions({
      options,
      selectedIds: new Set(['a']),
      query: '',
      rankMode: 'popularity'
    })

    expect(ranked.ordered.map((row) => row.id)).toEqual(['a', 'b', 'c', 'd'])
    expect(ranked.selectedCount).toBe(1)
    expect(ranked.unselectedCount).toBe(3)
    expect(ranked.unselectedIds).toEqual(['b', 'c', 'd'])
  })

  it('keeps registry order for hosts within each partition', () => {
    const ranked = rankPaletteFilterOptions({
      options,
      selectedIds: new Set(['c']),
      query: '',
      rankMode: 'registry'
    })

    expect(ranked.ordered.map((row) => row.id)).toEqual(['c', 'a', 'b', 'd'])
  })

  it('filters with pre-normalized searchText without re-lowercasing options', () => {
    const ranked = rankPaletteFilterOptions({
      options,
      selectedIds: new Set(),
      query: 'ssh',
      rankMode: 'popularity'
    })

    expect(ranked.ordered.map((row) => row.id)).toEqual(['d'])
  })

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

  it('collapses pinned selected rows when they would crowd the list', () => {
    const many = Array.from({ length: FILTER_OPTION_MAX_PINNED_SELECTED + 3 }, (_, i) =>
      option(`s${i}`, `Selected ${i}`, 1)
    )
    const rest = [option('u1', 'Unselected', 9)]
    const ranked = rankPaletteFilterOptions({
      options: [...many, ...rest],
      selectedIds: new Set(many.map((row) => row.id)),
      query: '',
      rankMode: 'popularity'
    })

    expect(ranked.selectedCollapsed).toBe(true)
    expect(ranked.selectedCount).toBe(many.length)
    expect(ranked.ordered.map((row) => row.id)).toEqual(['u1'])
  })
})
