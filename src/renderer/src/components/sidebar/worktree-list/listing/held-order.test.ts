import { describe, expect, it } from 'vitest'
import { mergeHeldOrder } from './held-order'

describe('mergeHeldOrder', () => {
  it('keeps the held order, and the same array, while the set is unchanged', () => {
    const held = ['a', 'b', 'c']
    expect(mergeHeldOrder(held, ['c', 'a', 'b'])).toBe(held)
  })

  it('drops a removed row and places a new one where the new order puts it', () => {
    expect(mergeHeldOrder(['a', 'b', 'c'], ['new', 'c', 'a'])).toEqual(['new', 'a', 'c'])
    expect(mergeHeldOrder(['a', 'b'], ['b', 'x', 'y', 'a'])).toEqual(['a', 'b', 'x', 'y'])
  })
})
