import { expect, it, vi } from 'vitest'
import { selectHostBalancedPage } from './host-balanced-listing-page'

it('retires exhausted host buckets from subsequent listing rounds', () => {
  const rows = [
    ...Array.from({ length: 1000 }, (_, index) => ({ host: `host-${index}`, id: index })),
    ...Array.from({ length: 2000 }, (_, index) => ({ host: 'large-host', id: 1000 + index }))
  ]
  const original = Map.prototype.values
  let reads = 0
  const spy = vi
    .spyOn(Map.prototype, 'values')
    .mockImplementation(function (this: Map<string, number[]>) {
      const iterator = original.call(this)
      if (!this.has('large-host')) {
        return iterator
      }
      return iterator.map(
        (bucket: number[]) =>
          new Proxy(bucket, {
            get(target, key, receiver) {
              if (typeof key === 'string' && /^\d+$/.test(key)) {
                reads += 1
              }
              return Reflect.get(target, key, receiver)
            }
          })
      )
    })
  let result: typeof rows
  try {
    result = selectHostBalancedPage(rows, 2000, (row) => row.host)
  } finally {
    spy.mockRestore()
  }
  expect(result!.map((row) => row.id)).toEqual(Array.from({ length: 2000 }, (_, index) => index))
  expect(reads).toBeLessThanOrEqual(2000)
})

// Retirement is only safe while every retained bucket outlives the round it is read at. If that
// predicate drifts, `bucket[round]` yields undefined and the page grows blank rows.
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
    // the page must stay a subsequence of the caller's original order
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
