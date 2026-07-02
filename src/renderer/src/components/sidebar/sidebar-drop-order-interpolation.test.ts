import { describe, expect, it } from 'vitest'
import { interpolateSparseOrder } from './sidebar-drop-order-interpolation'

describe('interpolateSparseOrder', () => {
  it('returns 0 when there are no neighbors', () => {
    expect(interpolateSparseOrder(undefined, undefined)).toBe(0)
  })
  it('returns one below the after-neighbor when dropping at the start', () => {
    expect(interpolateSparseOrder(undefined, 5)).toBe(4)
  })
  it('returns one above the before-neighbor when dropping at the end', () => {
    expect(interpolateSparseOrder(2, undefined)).toBe(3)
  })
  it('returns the midpoint between ascending neighbors', () => {
    expect(interpolateSparseOrder(2, 4)).toBe(3)
  })
  it('returns before+1 when neighbor ranks are not ascending (legacy duplicates)', () => {
    expect(interpolateSparseOrder(5, 5)).toBe(6)
  })
})
