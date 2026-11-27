import { describe, expect, it } from 'vitest'
import { sortWorkItemsByRecency } from './work-item-order'

const row = (repoId: string, number: number, createdAt?: string) => ({
  repoId,
  number,
  ...(createdAt ? { createdAt } : {})
})
const order = (items: ReturnType<typeof row>[]) =>
  sortWorkItemsByRecency(items, (item) => item).map((item) => `${item.repoId}#${item.number}`)

describe('sortWorkItemsByRecency', () => {
  it('merges repositories by creation time, keeping number order within one repo or without timestamps', () => {
    const highNumbers = [
      row('a', 736, '2026-11-23T12:00:00Z'),
      row('a', 572, '2026-10-08T12:00:00Z')
    ]
    const newest = row('b', 263, '2026-11-24T11:42:00Z')
    expect(order([...highNumbers, newest])).toEqual(['b#263', 'a#736', 'a#572'])
    // A transferred issue keeps its old creation date; one repo still follows GitHub's number order.
    expect(order([...highNumbers, row('a', 800, '2025-01-01T00:00:00Z')])).toEqual([
      'a#800',
      'a#736',
      'a#572'
    ])
    // An older host omits createdAt: fall back to number order rather than mixing keys.
    expect(order([...highNumbers, row('b', 263)])).toEqual(['a#736', 'a#572', 'b#263'])
  })
})
