export const RIGHT_SIDEBAR_MIN_WIDTH = 220
export const RIGHT_SIDEBAR_MIN_NON_SIDEBAR_AREA = 320
export const RIGHT_SIDEBAR_ABSOLUTE_FALLBACK_MAX_WIDTH = 2000
// The "expand" toggle targets this fraction of the window rather than the full
// max, so the editor/terminal keeps a usable strip instead of the 320px floor.
export const RIGHT_SIDEBAR_EXPANDED_WINDOW_FRACTION = 0.7

export function computeMaxRightSidebarPanelWidth(
  windowWidth: number | null | undefined,
  renderedExtraWidth: number
): number {
  if (typeof windowWidth !== 'number' || !Number.isFinite(windowWidth)) {
    return RIGHT_SIDEBAR_ABSOLUTE_FALLBACK_MAX_WIDTH
  }

  return Math.max(
    RIGHT_SIDEBAR_MIN_WIDTH,
    windowWidth - RIGHT_SIDEBAR_MIN_NON_SIDEBAR_AREA - renderedExtraWidth
  )
}

export function clampRightSidebarPanelWidth(
  width: number,
  windowWidth: number | null | undefined,
  renderedExtraWidth: number
): number {
  return Math.min(
    computeMaxRightSidebarPanelWidth(windowWidth, renderedExtraWidth),
    Math.max(RIGHT_SIDEBAR_MIN_WIDTH, width)
  )
}

export function computeExpandedRightSidebarPanelWidth(
  windowWidth: number | null | undefined,
  renderedExtraWidth: number
): number {
  if (typeof windowWidth !== 'number' || !Number.isFinite(windowWidth)) {
    return computeMaxRightSidebarPanelWidth(windowWidth, renderedExtraWidth)
  }

  return clampRightSidebarPanelWidth(
    Math.round(windowWidth * RIGHT_SIDEBAR_EXPANDED_WINDOW_FRACTION),
    windowWidth,
    renderedExtraWidth
  )
}
