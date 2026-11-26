import { describe, expect, it } from 'vitest'
import { countPinnedRows, nextVerticalTabIndex } from './vertical-tab-list-model'

describe('countPinnedRows', () => {
  it('groups only the leading pinned run, after the rows before `start`', () => {
    const rows = [true, true, false, true].map((isPinned) => ({ isPinned }))
    expect(countPinnedRows(rows)).toBe(2)
    // A bot's Home sits first in its own slot; the pinned group starts after it.
    expect(countPinnedRows([{ isPinned: false }, ...rows], 1)).toBe(2)
    expect(countPinnedRows(rows, 2)).toBe(0)
    expect(countPinnedRows([])).toBe(0)
  })
})

describe('nextVerticalTabIndex', () => {
  it('moves through the rows with wrapping and jumps with Home/End', () => {
    expect(nextVerticalTabIndex('ArrowDown', 0, 3)).toBe(1)
    expect(nextVerticalTabIndex('ArrowDown', 2, 3)).toBe(0)
    expect(nextVerticalTabIndex('ArrowUp', 0, 3)).toBe(2)
    expect(nextVerticalTabIndex('Home', 2, 3)).toBe(0)
    expect(nextVerticalTabIndex('End', 0, 3)).toBe(2)
  })

  it('enters from outside the list at its ends and ignores other keys', () => {
    expect(nextVerticalTabIndex('ArrowDown', -1, 3)).toBe(0)
    expect(nextVerticalTabIndex('ArrowUp', -1, 3)).toBe(2)
    expect(nextVerticalTabIndex('ArrowRight', 1, 3)).toBeNull()
    expect(nextVerticalTabIndex('ArrowDown', -1, 0)).toBeNull()
  })
})
