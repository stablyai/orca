// Collapsed-bar layout: which lanes claim a slot, how wide each wing is, and where the bar
// sits inside the wider panel. Pure arithmetic — no Electron, no DOM.
import type { NotchLane, NotchStatusSummary } from './notch-status-summary'

/** A hardware camera housing gets the notch-attached bar; every other display gets the pill. */
export type NotchPresentation = 'notch' | 'pill'

export type NotchWingSide = 'left' | 'right'

/** Width of one indicator: glyph, tight gap, up to two digits. */
export const STATUS_INDICATOR_SLOT_WIDTH = 30
export const STATUS_INDICATOR_SPACING = 6
export const PILL_WING_EDGE_PADDING = 6

export const TOP_SHOULDER_RADIUS = 14
export const BOTTOM_CORNER_RADIUS = 20

/**
 * Why: below the shoulder band the silhouette's straight side sits one shoulder radius inside
 * the bar's outer edge — a glyph closer than that gets bisected onto the wallpaper. Keeping
 * this tied to the radius means the clearance tracks the curve if the radius ever changes.
 */
const NOTCH_OUTER_WING_BREATHING_ROOM = 4
export const NOTCH_OUTER_WING_PADDING = TOP_SHOULDER_RADIUS + NOTCH_OUTER_WING_BREATHING_ROOM
/** Camera-facing edge: keeps the counter cluster clear of the physical cutout. */
export const NOTCH_INNER_WING_PADDING = 12
/** An empty continuation beside the camera, just enough to finish the silhouette. */
export const NOTCH_FAKE_WING_WIDTH = 28

const IDLE_WING_MIN_WIDTH = 46
const IDLE_WING_BASE_WIDTH = 28

/** A display reporting no menu bar still needs a strip to sit in. */
export const FALLBACK_MENU_BAR_HEIGHT = 24
export const PILL_TOP_GAP = 4
export const PILL_BOTTOM_INSET = 4

/** Narrowest notch we'll straddle, so a bogus geometry read can't collapse the wings. */
export const MIN_NOTCH_WIDTH = 168

// Working and done sit left of the camera; attention gets its own side so "needs you" reads
// distinctly even at a glance.
const LANE_SIDE: Record<NotchLane, NotchWingSide> = {
  working: 'left',
  done: 'left',
  attention: 'right'
}

export function sideForLane(lane: NotchLane): NotchWingSide {
  return LANE_SIDE[lane]
}

/** Lanes rendered on one side, in fixed order, omitting any with a zero count. */
export function visibleLanesForSide(summary: NotchStatusSummary, side: NotchWingSide): NotchLane[] {
  const ordered: NotchLane[] = side === 'left' ? ['working', 'done'] : ['attention']
  // Why: a zero-count lane claims no slot at all — leaving a reserved gap makes the bar look
  // broken rather than quiet.
  return ordered.filter((lane) => summary.counts[lane] > 0)
}

export type WingPadding = { leading: number; trailing: number }

export function wingPadding(presentation: NotchPresentation, side: NotchWingSide): WingPadding {
  if (presentation === 'pill') {
    return { leading: PILL_WING_EDGE_PADDING, trailing: PILL_WING_EDGE_PADDING }
  }
  return side === 'left'
    ? { leading: NOTCH_OUTER_WING_PADDING, trailing: NOTCH_INNER_WING_PADDING }
    : { leading: NOTCH_INNER_WING_PADDING, trailing: NOTCH_OUTER_WING_PADDING }
}

export type StatusWingWidthArgs = {
  visibleIndicatorCount: number
  showsIdleMark: boolean
  padding: WingPadding
}

/**
 * One slot per visible indicator plus the side's insets. The wings add up to exactly the
 * rendered content, so no invisible slack parks itself at one end of the bar.
 */
export function statusWingWidth({
  visibleIndicatorCount,
  showsIdleMark,
  padding
}: StatusWingWidthArgs): number {
  const leading = Number.isFinite(padding.leading) ? Math.max(0, padding.leading) : 0
  const trailing = Number.isFinite(padding.trailing) ? Math.max(0, padding.trailing) : 0
  const count = Math.max(0, Math.trunc(visibleIndicatorCount))

  if (count === 0) {
    // A quiet bar keeps the same minimum outer clearance as a populated wing.
    return showsIdleMark
      ? Math.max(IDLE_WING_MIN_WIDTH, IDLE_WING_BASE_WIDTH + leading + trailing)
      : 0
  }
  return (
    count * STATUS_INDICATOR_SLOT_WIDTH +
    Math.max(count - 1, 0) * STATUS_INDICATOR_SPACING +
    leading +
    trailing
  )
}

export type BalancedWings = { left: number; right: number }

/**
 * Why: with counts on only one side of the camera the silhouette reads unfinished, so the
 * empty side gets a plain stub. No width is mirrored back into the populated wing, and a real
 * indicator takes the stub's place the moment one exists.
 */
export function balanceWings(presentation: NotchPresentation, wings: BalancedWings): BalancedWings {
  if (presentation !== 'notch') {
    return wings
  }
  if (wings.left > 0 && wings.right === 0) {
    return { left: wings.left, right: NOTCH_FAKE_WING_WIDTH }
  }
  if (wings.left === 0 && wings.right > 0) {
    return { left: NOTCH_FAKE_WING_WIDTH, right: wings.right }
  }
  return wings
}

export type BarLeadingOffsetArgs = {
  presentation: NotchPresentation
  /** Panel width, which is far wider than the collapsed wings. */
  panelWidth: number
  panelOriginX: number
  /** Screen-space left edge of the physical cutout; null in pill mode. */
  notchLeadingX: number | null
  notchWidth: number
  wings: BalancedWings
}

/**
 * Horizontal origin of the collapsed bar inside the broad panel. On a notched display this
 * keeps the bar fused to the real cutout even though the panel is much wider.
 */
export function barLeadingOffset({
  presentation,
  panelWidth,
  panelOriginX,
  notchLeadingX,
  notchWidth,
  wings
}: BarLeadingOffsetArgs): number {
  if (presentation === 'notch') {
    return (notchLeadingX ?? panelOriginX) - wings.left - panelOriginX
  }
  return (panelWidth - (wings.left + notchWidth + wings.right)) / 2
}

export type CollapsedBarLayout = {
  presentation: NotchPresentation
  leftLanes: NotchLane[]
  rightLanes: NotchLane[]
  wings: BalancedWings
  /** Total painted width: both wings plus the cutout they straddle. */
  barWidth: number
  leadingOffset: number
  showsIdleMark: boolean
}

export type BuildCollapsedBarArgs = {
  summary: NotchStatusSummary
  presentation: NotchPresentation
  panelWidth: number
  panelOriginX: number
  notchLeadingX: number | null
  notchWidth: number
}

/** Single entry point the renderer calls; every wing rule resolved in one pass. */
export function buildCollapsedBarLayout({
  summary,
  presentation,
  panelWidth,
  panelOriginX,
  notchLeadingX,
  notchWidth
}: BuildCollapsedBarArgs): CollapsedBarLayout {
  const leftLanes = visibleLanesForSide(summary, 'left')
  const rightLanes = visibleLanesForSide(summary, 'right')
  const showsIdleMark = leftLanes.length === 0 && rightLanes.length === 0

  const rawWings: BalancedWings = {
    // The idle moon lives on the left wing only, so the right stays collapsed when quiet.
    left: statusWingWidth({
      visibleIndicatorCount: leftLanes.length,
      showsIdleMark,
      padding: wingPadding(presentation, 'left')
    }),
    right: statusWingWidth({
      visibleIndicatorCount: rightLanes.length,
      showsIdleMark: false,
      padding: wingPadding(presentation, 'right')
    })
  }
  const wings = balanceWings(presentation, rawWings)

  return {
    presentation,
    leftLanes,
    rightLanes,
    wings,
    barWidth: wings.left + notchWidth + wings.right,
    leadingOffset: barLeadingOffset({
      presentation,
      panelWidth,
      panelOriginX,
      notchLeadingX,
      notchWidth,
      wings
    }),
    showsIdleMark
  }
}
