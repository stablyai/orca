import { describe, expect, it } from 'vitest'
import {
  buildSessionGridDragOrder,
  pruneSessionGridTabOrder,
  sanitizeSessionGridTabOrder
} from './session-grid-tab-order'

describe('sanitizeSessionGridTabOrder', () => {
  it('drops duplicates and junk, keeping the first occurrence', () => {
    expect(sanitizeSessionGridTabOrder(['a', 'b', 'a', '', 'c', 'b'])).toEqual(['a', 'b', 'c'])
    expect(sanitizeSessionGridTabOrder(undefined)).toEqual([])
  })

  it('returns the same reference when already clean, so hydration is not a local edit', () => {
    const order = ['a', 'b', 'c']
    expect(sanitizeSessionGridTabOrder(order)).toBe(order)
  })
})

describe('pruneSessionGridTabOrder', () => {
  it('removes only the closed tab', () => {
    expect(pruneSessionGridTabOrder(['a', 'b', 'c'], 'b')).toEqual(['a', 'c'])
  })

  it('returns the same reference when the tab was not listed', () => {
    const order = ['a', 'c']
    expect(pruneSessionGridTabOrder(order, 'b')).toBe(order)
  })
})

describe('buildSessionGridDragOrder', () => {
  it('moves within the global list so cards outside a filter keep their positions', () => {
    // b and d belong to the filtered workspace; a and c must not move.
    expect(buildSessionGridDragOrder(['a', 'b', 'c', 'd'], 'd', 'b')).toEqual(['a', 'd', 'b', 'c'])
    expect(buildSessionGridDragOrder(['a', 'b', 'c', 'd'], 'b', 'd')).toEqual(['a', 'c', 'd', 'b'])
  })

  it('is a no-op for an unknown or same target', () => {
    expect(buildSessionGridDragOrder(['a', 'b'], 'a', 'a')).toBeNull()
    expect(buildSessionGridDragOrder(['a', 'b'], 'a', 'zzz')).toBeNull()
  })
})
