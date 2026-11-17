import { describe, expect, it } from 'vitest'
import { buildTabStripSegments, computeTabStripRange } from './tab-strip-window'

describe('tab strip window', () => {
  it('renders every tab below the windowing threshold', () => {
    expect(computeTabStripRange(99, 5000, 800)).toBeNull()
    expect(buildTabStripSegments(3, null, [])).toEqual([{ kind: 'tabs', start: 0, end: 3 }])
  })

  it('mounts the viewport plus a viewport each side, snapped to blocks', () => {
    // 800px shows 6 tabs of 144px; scrolled to tab 100.
    expect(computeTabStripRange(10_000, 14_400, 800)).toEqual({ start: 80, end: 112 })
    expect(computeTabStripRange(10_000, 0, 800)).toEqual({ start: 0, end: 16 })
    expect(computeTabStripRange(120, 16_000, 800)).toEqual({ start: 96, end: 120 })
  })

  it('keeps tabs outside the range mounted in place, with spacers around them', () => {
    expect(buildTabStripSegments(1000, { start: 80, end: 112 }, [5, 112, 999, 90])).toEqual([
      { kind: 'gap', start: 0, end: 5 },
      { kind: 'tabs', start: 5, end: 6 },
      { kind: 'gap', start: 6, end: 80 },
      { kind: 'tabs', start: 80, end: 113 },
      { kind: 'gap', start: 113, end: 999 },
      { kind: 'tabs', start: 999, end: 1000 }
    ])
  })

  it('clamps a range left over from before tabs closed', () => {
    expect(buildTabStripSegments(119, { start: 96, end: 120 }, [])).toEqual([
      { kind: 'gap', start: 0, end: 96 },
      { kind: 'tabs', start: 96, end: 119 }
    ])
    expect(buildTabStripSegments(1, { start: 4992, end: 5024 }, [0])).toEqual([
      { kind: 'tabs', start: 0, end: 1 }
    ])
  })
})
