export const RIGHT_SIDEBAR_MIN_WIDTH = 220
export const RIGHT_SIDEBAR_MIN_NON_SIDEBAR_AREA = 320
export const RIGHT_SIDEBAR_ABSOLUTE_FALLBACK_MAX_WIDTH = 2000

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

/** Width the sidebar opens to while it shows a chat visual: wide enough for a chart to read. */
export const RIGHT_SIDEBAR_VISUAL_PREFERRED_WIDTH = 720

/** The sidebar's width while it shows a visual: its own resize, else the wider of stored and preferred. */
export function rightSidebarVisualWidth(storedWidth: number, visualWidth: number | null): number {
  return visualWidth ?? Math.max(storedWidth, RIGHT_SIDEBAR_VISUAL_PREFERRED_WIDTH)
}
