import { describe, expect, it } from 'vitest'
import { MIN_COLUMN_WIDTH, splitColumnPair } from './column-widths'

describe('splitColumnPair', () => {
  it('keeps the pair total when the proposed second width falls below the minimum', () => {
    // A wide grid lets the handle propose a weight under the fr floor; the store must not raise it alone.
    expect(splitColumnPair(66, 54)).toEqual([MIN_COLUMN_WIDTH, MIN_COLUMN_WIDTH])
    expect(splitColumnPair(130, 54)).toEqual([124, MIN_COLUMN_WIDTH])
  })

  it('keeps the pair total when the proposed first width falls below the minimum', () => {
    expect(splitColumnPair(50, 150)).toEqual([MIN_COLUMN_WIDTH, 140])
  })

  it('rounds to whole weights with the rounded pair total held constant', () => {
    const [width, nextWidth] = splitColumnPair(100.6, 99.7)
    expect(width).toBe(101)
    expect(width + nextWidth).toBe(200)
  })
})
