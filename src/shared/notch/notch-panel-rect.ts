import {
  BOTTOM_CORNER_RADIUS,
  FALLBACK_MENU_BAR_HEIGHT,
  MIN_NOTCH_WIDTH,
  PILL_BOTTOM_INSET,
  PILL_TOP_GAP,
  TOP_SHOULDER_RADIUS,
  statusWingWidth,
  wingPadding,
  type NotchPresentation
} from './notch-bar-geometry'

export const EXPANDED_PANEL_WIDTH = 420
export const EXPANDED_CONTENT_WIDTH = 404
export const EXPANDED_CURVE_GUTTER = 8
/** Tallest card the panel must hold, before the list starts scrolling. */
export const MENU_MAX_HEIGHT = 316
export const EXPANDED_BOTTOM_PADDING = 8
const UNAVAILABLE_GEOMETRY_TOP_INSET = 48

export type ScreenBounds = { x: number; y: number; width: number; height: number }

export type NotchDisplayInfo = {
  displayId: number
  bounds: ScreenBounds
  /** `workArea.y - bounds.y`; 0 on a display reporting no menu bar. */
  menuBarHeight: number
  /** From the native geometry helper. Null whenever the helper is unavailable. */
  safeAreaTop: number | null
  /** Absolute screen-space edges of the camera cutout; null in pill mode. */
  notchLeadingX: number | null
  notchTrailingX: number | null
}

export type NotchPanelMetrics = {
  presentation: NotchPresentation
  /** Inset from the screen's top edge to the visible surface; 0 for a hardware notch. */
  topGap: number
  /** Visible height of the collapsed bar, excluding topGap. */
  barHeight: number
  notchWidth: number
  notchLeadingX: number | null
  panelWidth: number
  panelOriginX: number
  panelOriginY: number
  expandedHeight: number
  expandedContentSideInset: number
  cornerStyle: 'hanging-notch' | 'bubble'
  topShoulderRadius: number
  bottomCornerRadius: number
}

function clamp(value: number, min: number, max: number): number {
  // Why: a panel wider than the display inverts the bounds, so the max wins and we pin left.
  return max < min ? min : Math.min(Math.max(value, min), max)
}

function hasHardwareNotch(display: NotchDisplayInfo): display is NotchDisplayInfo & {
  safeAreaTop: number
  notchLeadingX: number
  notchTrailingX: number
} {
  return (
    (display.safeAreaTop ?? 0) > 0 &&
    display.notchLeadingX !== null &&
    display.notchTrailingX !== null
  )
}

/** Resolves presentation and every fixed measurement for one display. */
export function computeNotchPanelMetrics(display: NotchDisplayInfo): NotchPanelMetrics {
  const { bounds } = display
  const basePanelWidth = Math.min(EXPANDED_PANEL_WIDTH, Math.max(1, bounds.width))
  const panelOriginY = bounds.y

  if (hasHardwareNotch(display)) {
    const leading = display.notchLeadingX
    const trailing = display.notchTrailingX
    const barHeight = display.safeAreaTop
    const notchWidth = Math.max(trailing - leading, MIN_NOTCH_WIDTH)
    const notchCenterX = (leading + trailing) / 2
    const maxWingWidth = statusWingWidth({
      visibleIndicatorCount: 2,
      showsIdleMark: false,
      padding: wingPadding('notch', 'left')
    })
    const panelWidth = Math.min(
      bounds.width,
      Math.max(basePanelWidth, notchWidth + maxWingWidth * 2)
    )
    return {
      presentation: 'notch',
      topGap: 0,
      barHeight,
      notchWidth,
      notchLeadingX: notchCenterX - notchWidth / 2,
      panelWidth,
      // Centre the wide card on the camera housing, then keep it on this display.
      panelOriginX: clamp(
        notchCenterX - panelWidth / 2,
        bounds.x,
        bounds.x + bounds.width - panelWidth
      ),
      panelOriginY,
      expandedHeight: barHeight + MENU_MAX_HEIGHT + EXPANDED_BOTTOM_PADDING,
      expandedContentSideInset: TOP_SHOULDER_RADIUS,
      cornerStyle: 'hanging-notch',
      topShoulderRadius: TOP_SHOULDER_RADIUS,
      bottomCornerRadius: BOTTOM_CORNER_RADIUS
    }
  }

  const menuBar = display.menuBarHeight > 0 ? display.menuBarHeight : FALLBACK_MENU_BAR_HEIGHT
  // Gap plus capsule must stay inside the menu-bar strip so neither overlaps app content.
  const barHeight = Math.max(1, menuBar - PILL_TOP_GAP - PILL_BOTTOM_INSET)
  return {
    presentation: 'pill',
    topGap: PILL_TOP_GAP,
    barHeight,
    notchWidth: 0,
    notchLeadingX: null,
    panelWidth: basePanelWidth,
    panelOriginX: bounds.x + bounds.width / 2 - basePanelWidth / 2,
    // Auto-hidden menu bars can report zero even on a display with a physical camera cutout.
    panelOriginY:
      display.safeAreaTop === 0
        ? panelOriginY
        : panelOriginY + Math.max(menuBar, display.safeAreaTop ?? UNAVAILABLE_GEOMETRY_TOP_INSET),
    expandedHeight: barHeight + MENU_MAX_HEIGHT + EXPANDED_BOTTOM_PADDING,
    expandedContentSideInset: 0,
    cornerStyle: 'bubble',
    topShoulderRadius: 0,
    bottomCornerRadius: BOTTOM_CORNER_RADIUS
  }
}

export type WindowRect = { x: number; y: number; width: number; height: number }

function toIntegerRect(rect: WindowRect): WindowRect {
  // Enclose fractional display coordinates; the renderer preserves the remaining offset.
  return {
    x: Math.floor(rect.x),
    y: Math.round(rect.y),
    width: Math.max(1, Math.ceil(rect.x + rect.width) - Math.floor(rect.x)),
    height: Math.max(1, Math.round(rect.height))
  }
}

export function collapsedWindowRect(metrics: NotchPanelMetrics): WindowRect {
  return toIntegerRect({
    x: metrics.panelOriginX,
    y: metrics.panelOriginY,
    width: metrics.panelWidth,
    height: metrics.topGap + metrics.barHeight
  })
}

/** Single line: dot, workspace, elapsed. */
export const SESSION_ROW_HEIGHT = 30
/** ~8 rows; longer lists scroll inside the card rather than growing it. */
export const MAX_SESSION_LIST_HEIGHT = 240
const LIST_TOP_PADDING = 4
const LIST_BOTTOM_PADDING = 6

export function sessionListHeight(rowCount: number): number {
  const rows = Math.max(0, Math.trunc(rowCount))
  return Math.min(rows * SESSION_ROW_HEIGHT, MAX_SESSION_LIST_HEIGHT)
}

export function expandedWindowRect(metrics: NotchPanelMetrics, rowCount: number): WindowRect {
  const cardHeight = LIST_TOP_PADDING + sessionListHeight(rowCount) + LIST_BOTTOM_PADDING
  const height = metrics.topGap + metrics.barHeight + cardHeight + EXPANDED_BOTTOM_PADDING
  return toIntegerRect({
    x: metrics.panelOriginX,
    y: metrics.panelOriginY,
    width: metrics.panelWidth,
    height: Math.min(height, metrics.expandedHeight + metrics.topGap)
  })
}

/** Width available to expanded content once the curve gutters are removed. */
export function expandedContentWidth(panelWidth: number): number {
  if (!Number.isFinite(panelWidth)) {
    return 1
  }
  return Math.min(EXPANDED_CONTENT_WIDTH, Math.max(1, panelWidth - 2 * EXPANDED_CURVE_GUTTER))
}
