import { expect, it } from 'vitest'
import { selectHostBalancedPage } from './host-balanced-listing-page'

// Retained buckets must outlive their round index or undefined rows enter the page.
it('fills every cap exactly, without undefined or duplicate rows', () => {
  const rows = [
    ...Array.from({ length: 3 }, (_, index) => ({ host: 'a', id: index })),
    { host: 'b', id: 3 },
    ...Array.from({ length: 9 }, (_, index) => ({ host: 'c', id: 4 + index }))
  ]
  for (let limit = 0; limit < rows.length; limit += 1) {
    const page = selectHostBalancedPage(rows, limit, (row) => row.host)
    const pageIds = page.map((row) => row.id)
    expect(page).toHaveLength(limit)
    expect(page.every((row) => row !== undefined)).toBe(true)
    expect(new Set(pageIds).size).toBe(limit)
    expect(pageIds).toEqual([...pageIds].sort((left, right) => left - right))
  }
})

it('keeps starved hosts represented once a dominant bucket is retired', () => {
  const rows = [
    ...Array.from({ length: 2000 }, (_, index) => ({ host: 'big', id: index })),
    ...Array.from({ length: 40 }, (_, index) => ({ host: `small-${index}`, id: 2000 + index }))
  ]
  const page = selectHostBalancedPage(rows, 100, (row) => row.host)
  expect(new Set(page.map((row) => row.host)).size).toBe(41)
  expect(page.filter((row) => row.host === 'big')).toHaveLength(60)
})
