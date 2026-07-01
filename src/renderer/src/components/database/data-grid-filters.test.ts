import { describe, expect, it } from 'vitest'
import type { DbColumnFilter } from '../../../../shared/database-types'
import { filterFor, operatorTakesValue, setColumnFilter } from './data-grid-filters'

describe('operatorTakesValue', () => {
  it('is false for null-checks, true for comparisons', () => {
    expect(operatorTakesValue('is-null')).toBe(false)
    expect(operatorTakesValue('is-not-null')).toBe(false)
    expect(operatorTakesValue('=')).toBe(true)
    expect(operatorTakesValue('like')).toBe(true)
  })
})

describe('setColumnFilter', () => {
  const base: DbColumnFilter[] = [
    { column: 'a', operator: '=', value: 1 },
    { column: 'b', operator: '>', value: 2 }
  ]

  it('replaces an existing column filter, preserving other columns', () => {
    const next = setColumnFilter(base, 'a', { column: 'a', operator: '<', value: 9 })
    expect(next).toEqual([
      { column: 'b', operator: '>', value: 2 },
      { column: 'a', operator: '<', value: 9 }
    ])
  })

  it('removes a column filter when passed null', () => {
    const next = setColumnFilter(base, 'a', null)
    expect(next).toEqual([{ column: 'b', operator: '>', value: 2 }])
  })

  it('adds a new column filter', () => {
    const next = setColumnFilter([], 'c', { column: 'c', operator: 'is-null' })
    expect(next).toEqual([{ column: 'c', operator: 'is-null' }])
  })
})

describe('filterFor', () => {
  it('finds the predicate for a column', () => {
    const filters: DbColumnFilter[] = [{ column: 'x', operator: '=', value: 5 }]
    expect(filterFor(filters, 'x')).toEqual({ column: 'x', operator: '=', value: 5 })
    expect(filterFor(filters, 'y')).toBeUndefined()
  })
})
