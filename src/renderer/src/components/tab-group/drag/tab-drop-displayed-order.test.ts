import { describe, expect, it } from 'vitest'
import {
  reorderWithinDisplayedOrder,
  storedIndexForDisplayedDrop
} from './tab-drop-displayed-order'

// Stored [a, b, home, c] after a restore or a new tab; the bar draws the pinned Home first.
const stored = ['a', 'b', 'home', 'c']
const displayed = ['home', 'a', 'b', 'c']

describe('reorderWithinDisplayedOrder', () => {
  it('lands a tab dropped on the right of Home first after Home', () => {
    expect(reorderWithinDisplayedOrder(displayed, 'c', 'home', 'right')).toEqual([
      'home',
      'c',
      'a',
      'b'
    ])
  })

  it('moves forward past the tab it was dropped on', () => {
    expect(reorderWithinDisplayedOrder(displayed, 'a', 'b', 'right')).toEqual([
      'home',
      'b',
      'a',
      'c'
    ])
  })

  it('changes nothing for a drop beside its own slot or on a tab outside the group', () => {
    expect(reorderWithinDisplayedOrder(displayed, 'a', 'home', 'right')).toBeNull()
    expect(reorderWithinDisplayedOrder(displayed, 'a', 'gone', 'left')).toBeNull()
  })
})

describe('storedIndexForDisplayedDrop', () => {
  it('puts a tab from another group dropped after Home ahead of the first tab drawn after Home', () => {
    expect(storedIndexForDisplayedDrop(stored, displayed, 'home', 'right')).toBe(0)
  })

  it('uses the drawn neighbour, and the end after the last tab', () => {
    expect(storedIndexForDisplayedDrop(stored, displayed, 'b', 'left')).toBe(1)
    expect(storedIndexForDisplayedDrop(stored, displayed, 'c', 'right')).toBe(4)
  })

  it('keeps stored indices when the stored order is what the bar draws', () => {
    const plain = ['home', 'a', 'b']
    expect(storedIndexForDisplayedDrop(plain, plain, 'a', 'right')).toBe(2)
    expect(storedIndexForDisplayedDrop(plain, plain, 'missing', 'left')).toBe(3)
  })
})
