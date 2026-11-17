import { describe, expect, it } from 'vitest'
import {
  NOTCH_FAKE_WING_WIDTH,
  NOTCH_INNER_WING_PADDING,
  NOTCH_OUTER_WING_PADDING,
  PILL_WING_EDGE_PADDING,
  STATUS_INDICATOR_SLOT_WIDTH,
  STATUS_INDICATOR_SPACING,
  balanceWings,
  barLeadingOffset,
  buildCollapsedBarLayout,
  sideForLane,
  statusWingWidth,
  visibleLanesForSide,
  wingPadding
} from './notch-bar-geometry'
import type { NotchStatusSummary } from './notch-status-summary'

function summary(working: number, attention: number, done: number): NotchStatusSummary {
  return { counts: { working, attention, done }, sessions: [] }
}

describe('lane placement', () => {
  it('keeps the needs-you lane on its own side of the camera', () => {
    expect(sideForLane('working')).toBe('left')
    expect(sideForLane('done')).toBe('left')
    expect(sideForLane('attention')).toBe('right')
  })
})

describe('visibleLanesForSide', () => {
  it('omits a zero-count lane so it claims no slot', () => {
    expect(visibleLanesForSide(summary(2, 0, 0), 'left')).toEqual(['working'])
    expect(visibleLanesForSide(summary(2, 0, 0), 'right')).toEqual([])
  })

  it('keeps working before done on the left wing', () => {
    expect(visibleLanesForSide(summary(1, 0, 1), 'left')).toEqual(['working', 'done'])
  })

  it('returns nothing on either side when every lane is empty', () => {
    expect(visibleLanesForSide(summary(0, 0, 0), 'left')).toEqual([])
    expect(visibleLanesForSide(summary(0, 0, 0), 'right')).toEqual([])
  })
})

describe('wingPadding', () => {
  it('gives a hardware notch its outer clearance and a tighter camera-facing edge', () => {
    expect(wingPadding('notch', 'left')).toEqual({
      leading: NOTCH_OUTER_WING_PADDING,
      trailing: NOTCH_INNER_WING_PADDING
    })
    expect(wingPadding('notch', 'right')).toEqual({
      leading: NOTCH_INNER_WING_PADDING,
      trailing: NOTCH_OUTER_WING_PADDING
    })
  })

  it('pads a pill evenly on both edges', () => {
    expect(wingPadding('pill', 'left')).toEqual({
      leading: PILL_WING_EDGE_PADDING,
      trailing: PILL_WING_EDGE_PADDING
    })
  })

  it('clears the shoulder curve so the outer glyph is not bisected', () => {
    // Why: anything under the shoulder radius lands where the curve has peeled away.
    expect(NOTCH_OUTER_WING_PADDING).toBeGreaterThan(14)
  })
})

describe('statusWingWidth', () => {
  const padding = { leading: 6, trailing: 6 }

  it('sums slots, inter-slot gaps and both insets', () => {
    expect(statusWingWidth({ visibleIndicatorCount: 2, showsIdleMark: false, padding })).toBe(
      2 * STATUS_INDICATOR_SLOT_WIDTH + STATUS_INDICATOR_SPACING + 12
    )
  })

  it('adds no gap for a single indicator', () => {
    expect(statusWingWidth({ visibleIndicatorCount: 1, showsIdleMark: false, padding })).toBe(
      STATUS_INDICATOR_SLOT_WIDTH + 12
    )
  })

  it('collapses an empty wing to nothing', () => {
    expect(statusWingWidth({ visibleIndicatorCount: 0, showsIdleMark: false, padding })).toBe(0)
  })

  it('keeps a minimum width for the idle mark', () => {
    expect(
      statusWingWidth({ visibleIndicatorCount: 0, showsIdleMark: true, padding })
    ).toBeGreaterThanOrEqual(46)
  })

  it('ignores non-finite padding rather than producing NaN', () => {
    expect(
      statusWingWidth({
        visibleIndicatorCount: 1,
        showsIdleMark: false,
        padding: { leading: Number.NaN, trailing: Number.POSITIVE_INFINITY }
      })
    ).toBe(STATUS_INDICATOR_SLOT_WIDTH)
  })
})

describe('balanceWings', () => {
  it('stubs the empty side of a hardware notch so the silhouette finishes', () => {
    expect(balanceWings('notch', { left: 42, right: 0 })).toEqual({
      left: 42,
      right: NOTCH_FAKE_WING_WIDTH
    })
    expect(balanceWings('notch', { left: 0, right: 42 })).toEqual({
      left: NOTCH_FAKE_WING_WIDTH,
      right: 42
    })
  })

  it('never mirrors width back into the populated wing', () => {
    expect(balanceWings('notch', { left: 42, right: 0 }).left).toBe(42)
  })

  it('leaves both-populated and both-empty notches alone', () => {
    expect(balanceWings('notch', { left: 42, right: 30 })).toEqual({ left: 42, right: 30 })
    expect(balanceWings('notch', { left: 0, right: 0 })).toEqual({ left: 0, right: 0 })
  })

  it('leaves a pill unbalanced — it has no cutout to straddle', () => {
    expect(balanceWings('pill', { left: 42, right: 0 })).toEqual({ left: 42, right: 0 })
  })
})

describe('barLeadingOffset', () => {
  it('pins the bar to the real cutout on a notched display', () => {
    // Panel spans 800 from x=100; cutout starts at x=460; left wing is 48 wide.
    expect(
      barLeadingOffset({
        presentation: 'notch',
        panelWidth: 800,
        panelOriginX: 100,
        notchLeadingX: 460,
        notchWidth: 200,
        wings: { left: 48, right: 30 }
      })
    ).toBe(460 - 48 - 100)
  })

  it('centres the capsule inside the panel in pill mode', () => {
    expect(
      barLeadingOffset({
        presentation: 'pill',
        panelWidth: 800,
        panelOriginX: 0,
        notchLeadingX: null,
        notchWidth: 0,
        wings: { left: 100, right: 100 }
      })
    ).toBe(300)
  })

  it('falls back to the panel origin when notch geometry is missing', () => {
    expect(
      barLeadingOffset({
        presentation: 'notch',
        panelWidth: 800,
        panelOriginX: 100,
        notchLeadingX: null,
        notchWidth: 200,
        wings: { left: 48, right: 30 }
      })
    ).toBe(-48)
  })
})

describe('buildCollapsedBarLayout', () => {
  const notchArgs = {
    presentation: 'notch' as const,
    panelWidth: 800,
    panelOriginX: 100,
    notchLeadingX: 460,
    notchWidth: 200
  }

  it('splits lanes across the camera and spans both wings plus the cutout', () => {
    const layout = buildCollapsedBarLayout({ ...notchArgs, summary: summary(2, 1, 0) })

    expect(layout.leftLanes).toEqual(['working'])
    expect(layout.rightLanes).toEqual(['attention'])
    expect(layout.barWidth).toBe(layout.wings.left + 200 + layout.wings.right)
    expect(layout.showsIdleMark).toBe(false)
  })

  it('stubs the right wing when only the left is populated', () => {
    const layout = buildCollapsedBarLayout({ ...notchArgs, summary: summary(1, 0, 0) })

    expect(layout.rightLanes).toEqual([])
    expect(layout.wings.right).toBe(NOTCH_FAKE_WING_WIDTH)
  })

  it('shows the idle mark and still spans the cutout when nothing is running', () => {
    const layout = buildCollapsedBarLayout({ ...notchArgs, summary: summary(0, 0, 0) })

    expect(layout.showsIdleMark).toBe(true)
    expect(layout.wings.left).toBeGreaterThan(0)
    expect(layout.barWidth).toBeGreaterThan(200)
  })

  it('keeps the idle mark on one wing only', () => {
    const layout = buildCollapsedBarLayout({
      ...notchArgs,
      presentation: 'pill',
      notchWidth: 0,
      notchLeadingX: null,
      summary: summary(0, 0, 0)
    })

    expect(layout.wings.right).toBe(0)
  })

  it('grows the bar as more lanes become visible', () => {
    const one = buildCollapsedBarLayout({ ...notchArgs, summary: summary(1, 0, 0) })
    const two = buildCollapsedBarLayout({ ...notchArgs, summary: summary(1, 0, 1) })

    expect(two.wings.left).toBeGreaterThan(one.wings.left)
  })
})
