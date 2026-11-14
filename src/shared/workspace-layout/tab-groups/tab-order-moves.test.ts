import { describe, expect, it } from 'vitest'
import { tabOrderMoves } from './tab-order'

describe('tabOrderMoves', () => {
  it('is one move when one tab moved, either way', () => {
    expect(tabOrderMoves(['a', 'b', 'c', 'd'], ['b', 'c', 'a', 'd'])).toEqual([
      { tabId: 'a', index: 2 }
    ])
    expect(tabOrderMoves(['a', 'b', 'c', 'd'], ['a', 'd', 'b', 'c'])).toEqual([
      { tabId: 'd', index: 1 }
    ])
  })
})
