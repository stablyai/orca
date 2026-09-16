import { expect, it } from 'vitest'
import { sortByUpdatedAtDescending } from './updated-at-order'

it('reads each timestamp once and preserves in-place ordering including invalid dates', () => {
  let reads = 0
  const entries = Array.from({ length: 2000 }, (_, i) => ({
    id: i,
    get updatedAt() {
      reads++
      return i % 137 === 0
        ? 'invalid'
        : new Date(1700000000000 + ((i * 173) % 1999) * 1000).toISOString()
    }
  }))
  const expected = [...entries].sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  )
  expect(reads).toBeGreaterThan(10_000)
  reads = 0
  expect(sortByUpdatedAtDescending(entries)).toBe(entries)
  expect(reads).toBe(2000)
  entries.forEach((entry, i) => expect(entry).toBe(expected[i]))
})
