import { describe, expect, it } from 'vitest'
import { sameBucketRecords, sameProjectedItems } from './bucket-record-equality'

type Item = { id: string; value: number; noise?: number }

const sameItem = (previous: Item, next: Item): boolean =>
  previous.id === next.id && previous.value === next.value

describe('sameProjectedItems', () => {
  it('accepts the same array, including both sides missing', () => {
    const items: Item[] = [{ id: 'a', value: 1 }]
    expect(sameProjectedItems(items, items, () => false)).toBe(true)
    expect(sameProjectedItems<Item>(undefined, undefined, () => false)).toBe(true)
  })

  it('compares projections of new arrays and ignores unprojected fields', () => {
    expect(
      sameProjectedItems(
        [{ id: 'a', value: 1, noise: 1 }],
        [{ id: 'a', value: 1, noise: 2 }],
        sameItem
      )
    ).toBe(true)
    expect(sameProjectedItems([{ id: 'a', value: 1 }], [{ id: 'a', value: 2 }], sameItem)).toBe(
      false
    )
  })

  it('rejects a missing side, a length change, and holes', () => {
    const items: Item[] = [{ id: 'a', value: 1 }]
    expect(sameProjectedItems(undefined, items, sameItem)).toBe(false)
    expect(sameProjectedItems(items, undefined, sameItem)).toBe(false)
    expect(sameProjectedItems(items, [...items, { id: 'b', value: 1 }], sameItem)).toBe(false)
    const holed: (Item | undefined)[] = [undefined]
    expect(sameProjectedItems(holed, [undefined], () => true)).toBe(false)
  })
})

describe('sameBucketRecords', () => {
  it('compares each bucket under the projection', () => {
    const previous = { w: [{ id: 'a', value: 1, noise: 1 }] }
    expect(sameBucketRecords(previous, { w: [{ id: 'a', value: 1, noise: 9 }] }, sameItem)).toBe(
      true
    )
    expect(sameBucketRecords(previous, { w: [{ id: 'a', value: 2 }] }, sameItem)).toBe(false)
  })

  it('rejects added, removed, or renamed buckets', () => {
    const previous: Record<string, Item[]> = { w: [] }
    expect(sameBucketRecords(previous, { w: [], x: [] }, sameItem)).toBe(false)
    expect(sameBucketRecords(previous, {}, sameItem)).toBe(false)
    expect(sameBucketRecords(previous, { x: [] }, sameItem)).toBe(false)
  })
})
