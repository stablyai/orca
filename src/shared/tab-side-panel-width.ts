export const TAB_SIDE_PANEL_MIN_WIDTH = 160
export const TAB_SIDE_PANEL_DEFAULT_WIDTH = 240
export const TAB_SIDE_PANEL_MIN_BODY_WIDTH = 320
export const TAB_SIDE_PANEL_MAX_WIDTH = 600

export function computeMaxTabSidePanelWidth(groupWidth: number): number {
  if (!Number.isFinite(groupWidth) || groupWidth <= 0) {
    return TAB_SIDE_PANEL_MAX_WIDTH
  }

  return Math.min(
    TAB_SIDE_PANEL_MAX_WIDTH,
    Math.max(TAB_SIDE_PANEL_MIN_WIDTH, groupWidth - TAB_SIDE_PANEL_MIN_BODY_WIDTH)
  )
}

export function clampTabSidePanelWidth(
  width: unknown,
  groupWidth?: number,
  fallback = TAB_SIDE_PANEL_DEFAULT_WIDTH
): number {
  if (typeof width !== 'number' || !Number.isFinite(width)) {
    return fallback
  }

  const maxWidth =
    groupWidth !== undefined ? computeMaxTabSidePanelWidth(groupWidth) : TAB_SIDE_PANEL_MAX_WIDTH

  return Math.min(maxWidth, Math.max(TAB_SIDE_PANEL_MIN_WIDTH, width))
}

/** For saved or requested widths, where no group is measured and a bad value keeps the current one. */
export function restoreTabSidePanelWidth(width: unknown, current: number): number {
  return clampTabSidePanelWidth(width, undefined, current)
}
