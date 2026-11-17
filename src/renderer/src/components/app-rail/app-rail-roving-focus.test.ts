import { describe, expect, it } from 'vitest'
import { nextAppRailFocusIndex } from './app-rail-roving-focus'

describe('nextAppRailFocusIndex', () => {
  it('moves with the vertical arrow keys and wraps at both ends', () => {
    expect(nextAppRailFocusIndex('ArrowDown', 0, 3)).toBe(1)
    expect(nextAppRailFocusIndex('ArrowDown', 2, 3)).toBe(0)
    expect(nextAppRailFocusIndex('ArrowUp', 0, 3)).toBe(2)
  })

  it('jumps to the first and last items with Home and End', () => {
    expect(nextAppRailFocusIndex('Home', 2, 3)).toBe(0)
    expect(nextAppRailFocusIndex('End', 0, 3)).toBe(2)
  })

  it('ignores horizontal arrows and other keys', () => {
    expect(nextAppRailFocusIndex('ArrowRight', 0, 3)).toBeNull()
    expect(nextAppRailFocusIndex('Enter', 0, 3)).toBeNull()
  })
})
