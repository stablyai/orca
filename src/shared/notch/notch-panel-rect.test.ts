import { describe, expect, it } from 'vitest'
import { buildCollapsedBarLayout } from './notch-bar-geometry'
import type { NotchStatusSummary } from './notch-status-summary'
import {
  EXPANDED_PANEL_WIDTH,
  collapsedWindowRect,
  computeNotchPanelMetrics,
  expandedContentWidth,
  expandedWindowRect,
  type NotchDisplayInfo
} from './notch-panel-rect'

// A 14" MacBook Pro: 1512pt wide, ~200pt cutout centred on the top edge.
const NOTCHED: NotchDisplayInfo = {
  displayId: 1,
  bounds: { x: 0, y: 0, width: 1512, height: 982 },
  menuBarHeight: 38,
  safeAreaTop: 38,
  notchLeadingX: 656,
  notchTrailingX: 856
}

const EXTERNAL: NotchDisplayInfo = {
  displayId: 2,
  bounds: { x: 1512, y: 0, width: 2560, height: 1440 },
  menuBarHeight: 24,
  safeAreaTop: null,
  notchLeadingX: null,
  notchTrailingX: null
}

function summary(working: number, attention: number, done: number): NotchStatusSummary {
  return { counts: { working, attention, done }, sessions: [] }
}

describe('computeNotchPanelMetrics — hardware notch', () => {
  it('reads the cutout and sits flush with the screen edge', () => {
    const metrics = computeNotchPanelMetrics(NOTCHED)

    expect(metrics.presentation).toBe('notch')
    expect(metrics.topGap).toBe(0)
    expect(metrics.barHeight).toBe(38)
    expect(metrics.notchWidth).toBe(200)
    expect(metrics.panelOriginY).toBe(0)
    expect(metrics.cornerStyle).toBe('hanging-notch')
  })

  it('centres the panel on the camera housing', () => {
    const metrics = computeNotchPanelMetrics(NOTCHED)

    expect(metrics.panelWidth).toBe(EXPANDED_PANEL_WIDTH)
    expect(metrics.panelOriginX).toBe(756 - EXPANDED_PANEL_WIDTH / 2)
  })

  it('never lets a bogus cutout collapse the wings', () => {
    const metrics = computeNotchPanelMetrics({
      ...NOTCHED,
      notchLeadingX: 750,
      notchTrailingX: 760
    })

    expect(metrics.notchWidth).toBe(168)
  })

  it('insets expanded content by the shoulder radius', () => {
    expect(computeNotchPanelMetrics(NOTCHED).expandedContentSideInset).toBe(14)
  })

  it('falls back to the pill when the helper reported no safe area', () => {
    expect(computeNotchPanelMetrics({ ...NOTCHED, safeAreaTop: null }).presentation).toBe('pill')
  })

  it('falls back to the pill when only one cutout edge is known', () => {
    expect(computeNotchPanelMetrics({ ...NOTCHED, notchTrailingX: null }).presentation).toBe('pill')
  })
})

describe('computeNotchPanelMetrics — pill', () => {
  it('floats inside the menu-bar strip without overlapping app content', () => {
    const metrics = computeNotchPanelMetrics(EXTERNAL)

    expect(metrics.presentation).toBe('pill')
    expect(metrics.topGap).toBe(4)
    expect(metrics.topGap + metrics.barHeight).toBeLessThanOrEqual(EXTERNAL.menuBarHeight)
    expect(metrics.notchWidth).toBe(0)
    expect(metrics.cornerStyle).toBe('bubble')
  })

  it('uses the standard menu-bar height when a display reports none', () => {
    const metrics = computeNotchPanelMetrics({ ...EXTERNAL, menuBarHeight: 0 })

    expect(metrics.barHeight).toBe(24 - 4 - 4)
  })

  it('centres on a secondary display in global coordinates', () => {
    const metrics = computeNotchPanelMetrics(EXTERNAL)

    expect(metrics.panelOriginX).toBe(1512 + 2560 / 2 - EXPANDED_PANEL_WIDTH / 2)
  })

  it('keeps a positive bar height on an absurdly short menu bar', () => {
    expect(computeNotchPanelMetrics({ ...EXTERNAL, menuBarHeight: 2 }).barHeight).toBe(1)
  })

  it('adds the bubble header padding the notch does not need', () => {
    const pill = computeNotchPanelMetrics(EXTERNAL)
    const notch = computeNotchPanelMetrics(NOTCHED)

    expect(pill.expandedHeaderTopPadding).toBe(14)
    expect(notch.expandedHeaderTopPadding).toBe(0)
  })
})

describe('narrow displays', () => {
  it('keeps the panel fully on a display narrower than the ideal width', () => {
    const metrics = computeNotchPanelMetrics({
      ...EXTERNAL,
      bounds: { x: 0, y: 0, width: 320, height: 480 }
    })

    expect(metrics.panelWidth).toBe(320)
    expect(metrics.panelOriginX).toBe(0)
  })

  it('pins the panel to the left edge rather than inverting its bounds', () => {
    const metrics = computeNotchPanelMetrics({
      ...NOTCHED,
      bounds: { x: 0, y: 0, width: 700, height: 480 },
      notchLeadingX: 300,
      notchTrailingX: 400
    })

    expect(metrics.panelOriginX).toBeGreaterThanOrEqual(0)
    expect(metrics.panelOriginX + metrics.panelWidth).toBeLessThanOrEqual(700)
  })
})

describe('window rects', () => {
  it('sizes the collapsed window to exactly the painted bar', () => {
    const metrics = computeNotchPanelMetrics(NOTCHED)
    const layout = buildCollapsedBarLayout({
      summary: summary(2, 1, 0),
      presentation: metrics.presentation,
      panelWidth: metrics.panelWidth,
      panelOriginX: metrics.panelOriginX,
      notchLeadingX: metrics.notchLeadingX,
      notchWidth: metrics.notchWidth
    })
    const rect = collapsedWindowRect(metrics, layout)

    expect(rect.width).toBe(Math.round(layout.barWidth))
    expect(rect.height).toBe(38)
    expect(rect.y).toBe(0)
  })

  it('places the collapsed bar so the cutout falls inside it', () => {
    const metrics = computeNotchPanelMetrics(NOTCHED)
    const layout = buildCollapsedBarLayout({
      summary: summary(1, 1, 0),
      presentation: metrics.presentation,
      panelWidth: metrics.panelWidth,
      panelOriginX: metrics.panelOriginX,
      notchLeadingX: metrics.notchLeadingX,
      notchWidth: metrics.notchWidth
    })
    const rect = collapsedWindowRect(metrics, layout)

    expect(rect.x).toBeLessThanOrEqual(656)
    expect(rect.x + rect.width).toBeGreaterThanOrEqual(856)
  })

  it('expands to the full panel width, sized to the rows it holds', () => {
    const metrics = computeNotchPanelMetrics(NOTCHED)
    const rect = expandedWindowRect(metrics, 3)

    expect(rect.width).toBe(EXPANDED_PANEL_WIDTH)
    expect(rect.y).toBe(0)
    // bar + list top pad + 3 rows + list bottom pad + panel bottom pad
    expect(rect.height).toBe(38 + 4 + 3 * 30 + 6 + 8)
  })

  it('does not reserve a full-height card for a single row', () => {
    const metrics = computeNotchPanelMetrics(NOTCHED)

    expect(expandedWindowRect(metrics, 1).height).toBeLessThan(
      expandedWindowRect(metrics, 6).height
    )
  })

  it('caps the list once it would scroll', () => {
    const metrics = computeNotchPanelMetrics(NOTCHED)

    expect(expandedWindowRect(metrics, 20).height).toBe(expandedWindowRect(metrics, 40).height)
  })

  it('stays taller than the collapsed bar even with no rows', () => {
    const metrics = computeNotchPanelMetrics(NOTCHED)

    expect(expandedWindowRect(metrics, 0).height).toBeGreaterThan(metrics.barHeight)
  })

  it('returns integer bounds so no half-pixel drifts the bar', () => {
    const metrics = computeNotchPanelMetrics({
      ...EXTERNAL,
      bounds: { x: 0, y: 0, width: 1365, height: 768 }
    })
    const rect = expandedWindowRect(metrics, 2)

    expect(Number.isInteger(rect.x)).toBe(true)
    expect(Number.isInteger(rect.width)).toBe(true)
  })
})

describe('expandedContentWidth', () => {
  it('removes both curve gutters', () => {
    expect(expandedContentWidth(400)).toBe(384)
  })

  it('caps at the content width on a full-size panel', () => {
    expect(expandedContentWidth(EXPANDED_PANEL_WIDTH)).toBe(404)
  })

  it('stays positive on a degenerate width', () => {
    expect(expandedContentWidth(4)).toBe(1)
    expect(expandedContentWidth(Number.NaN)).toBe(1)
  })
})
