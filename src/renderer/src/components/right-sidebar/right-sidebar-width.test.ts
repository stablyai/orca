import { describe, expect, it } from 'vitest'
import {
  RIGHT_SIDEBAR_ABSOLUTE_FALLBACK_MAX_WIDTH,
  RIGHT_SIDEBAR_MIN_WIDTH,
  RIGHT_SIDEBAR_TASK_TAB_MIN_WIDTH,
  clampRightSidebarPanelWidth,
  computeMaxRightSidebarPanelWidth,
  getRightSidebarTabFloorWidth
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

describe('getRightSidebarTabFloorWidth', () => {
  it('gives the Task panel the room its provider detail view needs', () => {
    expect(getRightSidebarTabFloorWidth('task')).toBe(RIGHT_SIDEBAR_TASK_TAB_MIN_WIDTH)
  })

  it('leaves every other tab on the shared minimum', () => {
    expect(getRightSidebarTabFloorWidth('explorer')).toBe(RIGHT_SIDEBAR_MIN_WIDTH)
    expect(getRightSidebarTabFloorWidth('source-control')).toBe(RIGHT_SIDEBAR_MIN_WIDTH)
    expect(getRightSidebarTabFloorWidth('plugin:acme.tools/dashboard')).toBe(
      RIGHT_SIDEBAR_MIN_WIDTH
    )
  })

  it('keeps the floor inside the window budget on a narrow window', () => {
    // Why: the floor is a wish, not a guarantee. A narrow window keeps its
    // non-sidebar area rather than letting the panel push it off screen.
    expect(clampRightSidebarPanelWidth(getRightSidebarTabFloorWidth('task'), 700, 0)).toBeLessThan(
      RIGHT_SIDEBAR_TASK_TAB_MIN_WIDTH
    )
  })
})
