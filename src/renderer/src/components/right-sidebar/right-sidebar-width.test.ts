import { describe, expect, it } from 'vitest'
import {
  RIGHT_SIDEBAR_ABSOLUTE_FALLBACK_MAX_WIDTH,
  RIGHT_SIDEBAR_MIN_WIDTH,
  clampRightSidebarPanelWidth,
  computeExpandedRightSidebarPanelWidth,
  computeMaxRightSidebarPanelWidth
} from './right-sidebar-width'

describe('right sidebar rendered width', () => {
  it('leaves the reserved non-sidebar area when persisted width is too large', () => {
    expect(clampRightSidebarPanelWidth(900, 900, 0)).toBe(580)
  })

  it('includes rendered extra width in the reservation math', () => {
    expect(computeMaxRightSidebarPanelWidth(900, 40)).toBe(540)
    expect(clampRightSidebarPanelWidth(900, 900, 40)).toBe(540)
  })

  it('preserves the minimum sidebar width on narrow windows', () => {
    expect(clampRightSidebarPanelWidth(900, 400, 40)).toBe(RIGHT_SIDEBAR_MIN_WIDTH)
  })

  it('uses the fallback max outside DOM environments', () => {
    expect(computeMaxRightSidebarPanelWidth(null, 40)).toBe(
      RIGHT_SIDEBAR_ABSOLUTE_FALLBACK_MAX_WIDTH
    )
  })
})

describe('right sidebar expand target', () => {
  it('targets the configured fraction of the window width', () => {
    // 70% of 1440 = 1008.
    expect(computeExpandedRightSidebarPanelWidth(1440, 0)).toBe(1008)
  })

  it('never crowds the reserved non-sidebar area on wide windows', () => {
    // 1008 still leaves 432 for the editor, above the 320 floor.
    expect(computeExpandedRightSidebarPanelWidth(1440, 0)).toBeLessThanOrEqual(
      computeMaxRightSidebarPanelWidth(1440, 0)
    )
  })

  it('clamps to the minimum sidebar width on narrow windows', () => {
    expect(computeExpandedRightSidebarPanelWidth(400, 0)).toBe(RIGHT_SIDEBAR_MIN_WIDTH)
  })

  it('falls back to the max target outside DOM environments', () => {
    expect(computeExpandedRightSidebarPanelWidth(null, 40)).toBe(
      RIGHT_SIDEBAR_ABSOLUTE_FALLBACK_MAX_WIDTH
    )
  })
})
