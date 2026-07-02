import { describe, expect, it } from 'vitest'
import {
  cycleColumnSort,
  cycleOrdinalSort,
  ordinalSortDirectionFor,
  sortDirectionFor
} from './data-grid-sort-state'

describe('cycleColumnSort', () => {
  it('cycles the clicked column: unsorted → asc → desc → unsorted', () => {
    const asc = cycleColumnSort([], 'name')
    expect(asc).toEqual([{ column: 'name', direction: 'asc' }])
    const desc = cycleColumnSort(asc, 'name')
    expect(desc).toEqual([{ column: 'name', direction: 'desc' }])
    const off = cycleColumnSort(desc, 'name')
    expect(off).toEqual([])
  })

  it('starts a different column fresh at asc, replacing the prior sort', () => {
    const next = cycleColumnSort([{ column: 'name', direction: 'desc' }], 'age')
    expect(next).toEqual([{ column: 'age', direction: 'asc' }])
  })
})

describe('sortDirectionFor', () => {
  it('returns the direction only for the sorted column', () => {
    const sorts = [{ column: 'age', direction: 'desc' as const }]
    expect(sortDirectionFor(sorts, 'age')).toBe('desc')
    expect(sortDirectionFor(sorts, 'name')).toBeNull()
    expect(sortDirectionFor([], 'age')).toBeNull()
  })
})

describe('cycleOrdinalSort', () => {
  it('cycles a column by output ordinal: off → asc → desc → off', () => {
    const asc = cycleOrdinalSort(null, 2)
    expect(asc).toEqual({ ordinal: 2, direction: 'asc' })
    expect(cycleOrdinalSort(asc, 2)).toEqual({ ordinal: 2, direction: 'desc' })
    expect(cycleOrdinalSort({ ordinal: 2, direction: 'desc' }, 2)).toBeNull()
  })

  it('switches to a different ordinal fresh at asc', () => {
    expect(cycleOrdinalSort({ ordinal: 2, direction: 'desc' }, 3)).toEqual({
      ordinal: 3,
      direction: 'asc'
    })
  })
})

describe('ordinalSortDirectionFor', () => {
  it('returns the direction only for the sorted ordinal', () => {
    expect(ordinalSortDirectionFor({ ordinal: 2, direction: 'desc' }, 2)).toBe('desc')
    expect(ordinalSortDirectionFor({ ordinal: 2, direction: 'desc' }, 1)).toBeNull()
    expect(ordinalSortDirectionFor(null, 2)).toBeNull()
  })
})
