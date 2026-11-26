import { describe, expect, it } from 'vitest'
import {
  buildTabStripSegments,
  computeTabStripRange,
  TAB_STRIP_WINDOW_MIN_TABS
} from './tab-strip-window'
import { VERTICAL_TAB_ROW_PX } from './tab-width-rules'

describe('vertical tab list window', () => {
  it('mounts the rows around a scrolled viewport and spaces the rest by row height', () => {
    // 400 rows of 32px under a 640px list scrolled to row 200.
    const range = computeTabStripRange(400, 200 * VERTICAL_TAB_ROW_PX, 640, VERTICAL_TAB_ROW_PX)
    expect(range).toEqual({ start: 176, end: 240 })
    const segments = buildTabStripSegments(400, range, [3])
    expect(segments).toEqual([
      { kind: 'gap', start: 0, end: 3 },
      { kind: 'tabs', start: 3, end: 4 },
      { kind: 'gap', start: 4, end: 176 },
      { kind: 'tabs', start: 176, end: 240 },
      { kind: 'gap', start: 240, end: 400 }
    ])
  })

  it('renders every row below the window threshold', () => {
    expect(computeTabStripRange(TAB_STRIP_WINDOW_MIN_TABS - 1, 0, 640, VERTICAL_TAB_ROW_PX)).toBe(
      null
    )
  })
})
