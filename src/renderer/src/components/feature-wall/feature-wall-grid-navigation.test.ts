import { describe, expect, it } from 'vitest'
import { getFeatureWallGridNavigationTarget } from './feature-wall-grid-navigation'

describe('getFeatureWallGridNavigationTarget', () => {
  it('keeps right/down movement bounded in the 3 + 3 + 1 layout', () => {
    const target = (currentIndex: number, key: 'ArrowRight' | 'ArrowDown') =>
      getFeatureWallGridNavigationTarget({
        currentIndex,
        key,
        tileCount: 7,
        columnCount: 3
      })

    expect(target(2, 'ArrowRight')).toBe(2)
    expect(target(5, 'ArrowRight')).toBe(5)
    expect(target(6, 'ArrowRight')).toBe(6)
    expect(target(4, 'ArrowDown')).toBe(4)
    expect(target(5, 'ArrowDown')).toBe(5)
  })

  it('moves vertically by the active column count', () => {
    const target = (currentIndex: number, key: 'ArrowUp' | 'ArrowDown') =>
      getFeatureWallGridNavigationTarget({
        currentIndex,
        key,
        tileCount: 7,
        columnCount: 2
      })

    expect(target(0, 'ArrowDown')).toBe(2)
    expect(target(4, 'ArrowUp')).toBe(2)
    expect(target(5, 'ArrowDown')).toBe(5)
  })

  it('jumps Home and End to the first and last tile', () => {
    expect(
      getFeatureWallGridNavigationTarget({
        currentIndex: 3,
        key: 'Home',
        tileCount: 7,
        columnCount: 3
      })
    ).toBe(0)
    expect(
      getFeatureWallGridNavigationTarget({
        currentIndex: 3,
        key: 'End',
        tileCount: 7,
        columnCount: 3
      })
    ).toBe(6)
  })
})
